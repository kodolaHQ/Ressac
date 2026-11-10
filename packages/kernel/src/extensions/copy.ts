import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { parseManifest, messageFiles, type ManifestAnalysis } from "./manifest.js";

/** Folder of the guards shipped with the kernel; a browser that embeds the kernel can provide another. */
export const DEFAULT_GUARDS = join(import.meta.dirname, "..", "..", "extensions");

export const FILES_MAX = 2000;
export const MAX_SIZE = 20 * 1024 * 1024;
/** Files and folders counted together. */
export const MAX_ENTRIES = 5000;
export const DEPTH_MAX = 32;

const PAGE_FIXES = "webaios-page-fixes.js";
const PAGE_GUARD = "webaios-page-guard.js";
const KEEP_BACKGROUND = "webaios-background-guard.js";
const BACKGROUND = "webaios-background.js";
const GUARDS = [PAGE_FIXES, PAGE_GUARD, KEEP_BACKGROUND];
/** The scope of the copy (`reseau`, `hotes`) for the page guard: injected by executeScript and registerContentScripts. */
const SCOPE = "webaios-scope.js";
/**
 * A marker per .js or .css file of the agent (`webaios-files/<n>.js`: `__webaiosFile(n)`). Content scripts
 * (manifest and registerContentScripts) declare only the guards and these markers; the background guard injects the real
 * files after the main process's reply (a tab), through the table put at the head of webaios-background-guard.js.
 */
const MARKERS = "webaios-files";

/** CSP of an agent copy: `connect-src` opens only to the domains of `reseau`, over https and wss (WebSocket). */
export function cspAgent(network: readonly string[]): string {
  return (
    "default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'self'" +
    network.map((d) => ` https://${d} wss://${d}`).join("") +
    "; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'none'; frame-ancestors 'self'"
  );
}

type Manifest = Record<string, unknown>;

function object(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** JSON of a file (BOM tolerated); `undefined` if it is unreadable. */
function json(content: Buffer | undefined): unknown {
  if (!content) return undefined;
  try {
    return JSON.parse(content.toString("utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

class ReadDenial extends Error {}

const LINKS = new Set(["ELOOP", "EMLINK", "ENOTDIR"]);
// O_NOFOLLOW: a link in place of the file makes the open fail; O_NONBLOCK: a pipe does not block.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The source folder actually read (resolved path, dev/ino): the caller checks it is the one it vetted. */
export interface RootRead {
  path: string;
  dev: number;
  ino: number;
}

interface Marker {
  path: string;
  dev: number;
  ino: number;
}

/**
 * Ordinary files of the folder (relative paths with `/`), read without following any link. Each file is opened
 * with `O_NOFOLLOW` and must be the one seen by `lstat` (same dev/ino), with no other hard link; each folder must
 * stay the same during its read, and the parent folders are re-checked after each file. A link, a
 * special file, a replacement during the read, or exceeding the limits gives a denial (the walk
 * stops).
 */
export async function readFolder(source: string): Promise<{ files: Map<string, Buffer>; denial: string[]; root?: RootRead }> {
  const files = new Map<string, Buffer>();
  const root = join(await realpath(dirname(source)), basename(source));
  let size = 0;
  let entries = 0;
  const deny = (message: string): never => {
    throw new ReadDenial(message);
  };
  const absolute = (rel: string) => (rel ? join(root, rel) : root);
  const checkFolders = async (chain: Marker[]): Promise<void> => {
    for (const d of chain) {
      const info = await lstat(absolute(d.path)).catch(() => null);
      if (!info?.isDirectory() || info.dev !== d.dev || info.ino !== d.ino) {
        deny(`Dossier remplacé pendant la lecture : ${d.path || "."}`);
      }
    }
  };
  const readTextFile = async (path: string, seen: Marker): Promise<Buffer> => {
    let fh: FileHandle;
    try {
      fh = await open(absolute(path), READ_FLAGS);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (LINKS.has(code)) deny(`Lien symbolique refusé : ${path}`);
      if (code === "ENOENT") deny(`Fichier remplacé pendant la lecture : ${path}`);
      throw e;
    }
    try {
      const info = await fh.stat();
      if (!info.isFile() || info.dev !== seen.dev || info.ino !== seen.ino) {
        deny(`Fichier remplacé pendant la lecture : ${path}`);
      }
      if (info.nlink !== 1) deny(`Lien physique refusé : ${path}`);
      const rest = MAX_SIZE - size;
      const chunks: Buffer[] = [];
      let parsed = 0;
      for (;;) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, rest + 1 - parsed));
        const { bytesRead } = await fh.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        chunks.push(buffer.subarray(0, bytesRead));
        parsed += bytesRead;
        if (parsed > rest) deny(`Extension trop lourde : ${MAX_SIZE / 1024 / 1024} Mo au plus`);
      }
      size += parsed;
      return Buffer.concat(chunks);
    } finally {
      await fh.close();
    }
  };
  const walk = async (chain: Marker[]): Promise<void> => {
    const folder = chain[chain.length - 1]!;
    let names: string[];
    try {
      names = (await readdir(absolute(folder.path))).sort();
    } catch (e) {
      if (["ENOENT", ...LINKS].includes((e as NodeJS.ErrnoException).code ?? "")) {
        deny(`Dossier remplacé pendant la lecture : ${folder.path || "."}`);
      }
      throw e;
    }
    await checkFolders(chain);
    for (const name of names) {
      const path = folder.path ? `${folder.path}/${name}` : name;
      if (++entries > MAX_ENTRIES) deny(`Trop d'entrées : ${MAX_ENTRIES} fichiers et dossiers au plus`);
      if (path.split("/").length > DEPTH_MAX) deny(`Arborescence trop profonde : ${DEPTH_MAX} niveaux au plus`);
      const info = await lstat(absolute(path)).catch(() => deny(`Fichier remplacé pendant la lecture : ${path}`));
      const marker = { path: path, dev: info.dev, ino: info.ino };
      if (info.isSymbolicLink()) deny(`Lien symbolique refusé : ${path}`);
      if (info.isDirectory()) {
        await walk([...chain, marker]);
        continue;
      }
      if (!info.isFile()) deny(`Fichier spécial refusé : ${path}`);
      if (files.size >= FILES_MAX) deny(`Trop de fichiers : ${FILES_MAX} au plus`);
      files.set(path, await readTextFile(path, marker));
      await checkFolders(chain);
    }
  };
  let loaded: RootRead | undefined;
  try {
    const info = await lstat(root);
    if (!info.isDirectory()) deny("Le dossier de l'extension n'est pas un dossier");
    loaded = { path: root, dev: info.dev, ino: info.ino };
    await walk([{ path: "", dev: info.dev, ino: info.ino }]);
  } catch (e) {
    if (e instanceof ReadDenial) return { files: files, denial: [e.message], ...(loaded ? { root: loaded } : {}) };
    throw e;
  }
  return { files: files, denial: [], root: loaded };
}

export function hashOf(files: Map<string, Buffer>): string {
  const h = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    const content = files.get(path)!;
    h.update(`${path}\0${content.length}\0`);
    h.update(content);
  }
  return h.digest("hex");
}

/** Static DNR rules declared by the manifest, read among the folder's files (absent if unreadable). */
function rulesOf(manifest: unknown, files: Map<string, Buffer>): Record<string, unknown> {
  const rules: Record<string, unknown> = {};
  const resources = object(object(manifest)?.declarative_net_request)?.rule_resources;
  if (!Array.isArray(resources)) return rules;
  for (const res of resources) {
    const path = object(res)?.path;
    if (typeof path !== "string") continue;
    const content = json(files.get(posix.normalize(path)));
    if (content !== undefined) rules[path] = content;
  }
  return rules;
}

/** The files the background can inject into a page: each .js and .css of the agent, sorted (the index is the marker). */
function fileTable(files: Map<string, Buffer>): [string, "js" | "css"][] {
  const table: [string, "js" | "css"][] = [];
  for (const path of [...files.keys()].sort()) {
    if (/\.js$/i.test(path)) table.push([path, "js"]);
    else if (/\.css$/i.test(path)) table.push([path, "css"]);
  }
  return table;
}

/**
 * Each `content_scripts[i]` entry declares only the guards, the scope and a marker per file (CSS first,
 * then JS, in manifest order); its `css` is removed. Nothing of the agent's is pasted in: its files are injected
 * by the background after the reply. Denial: a file that is absent or outside the folder. Also returns the sites of these entries.
 */
function rewriteScripts(
  manifest: Manifest,
  table: [string, "js" | "css"][],
): { denial: string[]; sites: string[] } {
  const denial: string[] = [];
  const sites: string[] = [];
  if (!Array.isArray(manifest.content_scripts)) return { denial: denial, sites };
  const hint = new Map(table.map(([path, kind], i) => [`${kind}:${path}`, i]));
  manifest.content_scripts = manifest.content_scripts.map((cs) => {
    const c = object(cs);
    if (!c) return cs;
    const markers: string[] = [];
    for (const kind of ["css", "js"] as const) {
      if (!Array.isArray(c[kind])) continue;
      for (const raw of c[kind] as unknown[]) {
        const path = typeof raw === "string" ? posix.normalize(raw.replace(/^\/+/, "")) : "";
        const i = hint.get(`${kind}:${path}`);
        if (!path || path.startsWith("..") || i === undefined) denial.push(`Script de contenu introuvable : ${String(raw)}`);
        else markers.push(`${MARKERS}/${i}.js`);
      }
    }
    if (markers.length === 0) return cs;
    for (const m of Array.isArray(c.matches) ? c.matches : []) if (typeof m === "string" && !sites.includes(m)) sites.push(m);
    const { css: _css, ...rest } = c;
    return { ...rest, js: [PAGE_FIXES, PAGE_GUARD, SCOPE, ...markers] };
  });
  return { denial: denial, sites };
}

const TAG_GUARD = Buffer.from(`<script src="/${KEEP_BACKGROUND}"></script>`);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Prefixes the bytes of an HTML page with the background guard (after a BOM and a `<!doctype …>` placed at the very
 * start): nothing can precede it, no comment, no `<base>`, no encoding change; the rest is intact.
 */
function insertPageGuard(page: Buffer): Buffer {
  let position = page.subarray(0, 3).equals(BOM) ? 3 : 0;
  const doctype = /^<!doctype[^>]*>/i.exec(page.subarray(position, position + 1024).toString("latin1"));
  if (doctype) position += doctype[0].length;
  return Buffer.concat([page.subarray(0, position), TAG_GUARD, page.subarray(position)]);
}

const DOCUMENTS_REFUSES = /\.(xhtml|xht|xml|xsl|xslt|mht|mhtml|svgz)$/i;
const PAGES = /\.(html?|shtml)$/i;
const SVG_WORDS = ["javascript:", "script", "foreignobject", "<!entity"];

/** UTF-16 BOM (FF FE, FE FF) or UTF-32 (FF FE 00 00, 00 00 FE FF). */
function bomUtf16Ou32(o: Buffer): boolean {
  return (
    (o[0] === 0xff && o[1] === 0xfe) ||
    (o[0] === 0xfe && o[1] === 0xff) ||
    (o.length >= 4 && o[0] === 0 && o[1] === 0 && o[2] === 0xfe && o[3] === 0xff)
  );
}

/** Closed rule: the reason for denying an SVG, or null if it is accepted. */
function svgDenial(content: Buffer): string | null {
  if (bomUtf16Ou32(content)) return "encodage UTF-16 ou UTF-32";
  if (content.includes(0)) return "octet NUL";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content).toLowerCase();
  } catch {
    return "UTF-8 invalide";
  }
  const word = SVG_WORDS.find((m) => text.includes(m));
  if (word) return `contient « ${word} »`;
  if (/\bon[a-z]+\s*=/i.test(text)) return "attribut on…=";
  return null;
}

/** Denials specific to file content: reserved names, non-HTML documents, active SVGs, UTF-16/32 pages. */
function filesDenial(files: Map<string, Buffer>): string[] {
  const denial: string[] = [];
  const reserved = new Set([BACKGROUND, ...GUARDS]);
  for (const [path, content] of files) {
    // Any top-level name in « webaios- »: guards, scope, markers (webaios-files/).
    const first = path.split("/")[0]!.normalize("NFC").toLowerCase();
    if (reserved.has(first) || first.startsWith("webaios-")) denial.push(`Nom de fichier réservé à WebAiOs : ${path}`);
    const document = DOCUMENTS_REFUSES.exec(path);
    if (document) denial.push(`Type de fichier refusé (.${document[1]!.toLowerCase()}) : ${path}`);
    if (/\.svg$/i.test(path)) {
      const reason = svgDenial(content);
      if (reason) denial.push(`Image SVG refusée (${reason}) : ${path}`);
    }
    if (PAGES.test(path) && bomUtf16Ou32(content)) {
      denial.push(`Page HTML refusée (encodage UTF-16 ou UTF-32) : ${path}`);
    }
  }
  return denial;
}

const AGENT_MINIMAL_BACKGROUND = `// Généré par WebAiOs : l'extension n'a pas de fond ; celui-ci, le garde seul, active ses rulesets et onInstalled.\nimportScripts(${JSON.stringify(KEEP_BACKGROUND)});\n`;
function generatedBackground(original: string, module: boolean): string {
  const path = original.replace(/^(\.\/|\/)+/, "");
  const header = "// Généré par WebAiOs : le garde, puis le service worker de l'extension.\n";
  if (module) return `${header}import "./${KEEP_BACKGROUND}";\nimport ${JSON.stringify("./" + path)};\n`;
  return `${header}importScripts(${JSON.stringify(KEEP_BACKGROUND)}, ${JSON.stringify(path)});\n`;
}

/** Puts `nouveau` in place of `cible`: two renames (a non-empty folder cannot be replaced in one go). */
async function replaceFolder(fresh: string, target: string): Promise<void> {
  const old = `${target}.${randomUUID()}.ancienne`;
  let moved = false;
  try {
    await rename(target, old);
    moved = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    await rename(fresh, target);
  } catch (e) {
    if (moved) await rename(old, target).catch(() => undefined);
    throw e;
  }
  if (moved) await rm(old, { recursive: true, force: true });
}

/**
 * Controlled copy of an agent extension: `source` is read without following any link, analyzed, and if there is
 * no denial, the copy (CSP imposed, guards at the head, `webaios.json`, `key` and `update_url` removed) replaces
 * `cible` in one go. With a denial, nothing is written.
 */
export async function prepareCopy(o: {
  source: string;
  target: string;
  keptFolder: string;
}): Promise<{ analysis: ManifestAnalysis; hash: string; root?: RootRead }> {
  const { files: files, denial: folderDenial, root: root } = await readFolder(o.source);
  const raw = json(files.get("manifest.json"));
  const rawWebaios = files.get("webaios.json");
  const webaios = rawWebaios === undefined ? undefined : (json(rawWebaios) ?? "illisible");
  const messages = messageFiles(raw).map((f) => json(files.get(f)));
  const analysis = parseManifest(raw, { source: "agent", webaios, rules: rulesOf(raw, files), messages });
  analysis.denial = [...folderDenial, ...filesDenial(files), ...analysis.denial];
  const hash = hashOf(files);
  const loaded = root ? { root: root } : {};
  if (analysis.denial.length > 0) return { analysis: analysis, hash: hash, ...loaded };

  const manifest = { ...(raw as Manifest) };
  delete manifest.key;
  delete manifest.update_url;
  manifest.content_security_policy = { extension_pages: cspAgent(analysis.scope.network) };
  const scope = `globalThis.__webaiosScope(${JSON.stringify({ network: analysis.scope.network, hosts: analysis.scope.hosts })});`;
  const table = fileTable(files);
  const rewritten = rewriteScripts(manifest, table);
  if (rewritten.denial.length > 0) {
    analysis.denial = [...analysis.denial, ...rewritten.denial];
    return { analysis: analysis, hash: hash, ...loaded };
  }
  if (rewritten.sites.length > 0) {
    // The background injects files through `scripting`, which asks for the right and the hosts of the content scripts (already
    // granted: the scope counts these sites). Only the copy carries them, the analysis stays that of the source.
    const permissions = Array.isArray(manifest.permissions) ? (manifest.permissions as unknown[]) : [];
    if (!permissions.includes("scripting")) manifest.permissions = [...permissions, "scripting"];
    const hosts = Array.isArray(manifest.host_permissions) ? (manifest.host_permissions as unknown[]) : [];
    manifest.host_permissions = [...hosts, ...rewritten.sites.filter((x) => !hosts.includes(x))];
  }
  const background = object(manifest.background);
  let backgroundJs: string;
  if (background && typeof background.service_worker === "string") {
    backgroundJs = generatedBackground(background.service_worker, background.type === "module");
    manifest.background = { ...background, service_worker: BACKGROUND };
  } else {
    // Without a background, nothing would activate its rulesets or fire onInstalled (the guard runs in the background):
    // a minimal background, the guard alone, is declared.
    backgroundJs = AGENT_MINIMAL_BACKGROUND;
    manifest.background = { service_worker: BACKGROUND };
  }

  const tmp = `${o.target}.${randomUUID()}.tmp`;
  try {
    await mkdir(tmp, { recursive: true });
    for (const [path, content] of files) {
      if (path === "webaios.json" || path === "manifest.json") continue;
      const destination = join(tmp, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(
        destination,
        PAGES.test(path) ? insertPageGuard(content) : content,
      );
    }
    for (const g of GUARDS) await copyFile(join(o.keptFolder, g), join(tmp, g));
    // The table at the head of the background guard: it is read before any script of the extension, which can no longer change it.
    await writeFile(
      join(tmp, KEEP_BACKGROUND),
      Buffer.concat([Buffer.from(`const __webaiosFiles = ${JSON.stringify(table)};\n`), await readFile(join(o.keptFolder, KEEP_BACKGROUND))]),
    );
    await writeFile(join(tmp, SCOPE), `${scope}\n`);
    await mkdir(join(tmp, MARKERS), { recursive: true });
    for (let i = 0; i < table.length; i++) await writeFile(join(tmp, MARKERS, `${i}.js`), `globalThis.__webaiosFile(${i});\n`);
    await writeFile(join(tmp, BACKGROUND), backgroundJs);
    await writeFile(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2));
    await replaceFolder(tmp, o.target);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return { analysis: analysis, hash: hash, ...loaded };
}
