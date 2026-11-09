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
export const TAILLE_MAX = 20 * 1024 * 1024;
/** Files and folders counted together. */
export const ENTREES_MAX = 5000;
export const DEPTH_MAX = 32;

const PAGE_FIXES = "webaios-correctifs-page.js";
const PAGE_GUARD = "webaios-garde-page.js";
const KEEP_BACKGROUND = "webaios-garde-fond.js";
const FOND = "webaios-fond.js";
const GUARDS = [PAGE_FIXES, PAGE_GUARD, KEEP_BACKGROUND];
/** The scope of the copy (`reseau`, `hotes`) for the page guard: injected by executeScript and registerContentScripts. */
const SCOPE = "webaios-portee.js";
/**
 * A marker per .js or .css file of the agent (`webaios-fichiers/<n>.js`: `__webaiosFichier(n)`). Content scripts
 * (manifest and registerContentScripts) declare only the guards and these markers; the background guard injects the real
 * files after the main process's reply (a tab), through the table put at the head of webaios-garde-fond.js.
 */
const MARKERS = "webaios-fichiers";

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

const LIENS = new Set(["ELOOP", "EMLINK", "ENOTDIR"]);
// O_NOFOLLOW: a link in place of the file makes the open fail; O_NONBLOCK: a pipe does not block.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The source folder actually read (resolved path, dev/ino): the caller checks it is the one it vetted. */
export interface RootRead {
  chemin: string;
  dev: number;
  ino: number;
}

interface Marker {
  chemin: string;
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
async function lireDossier(source: string): Promise<{ fichiers: Map<string, Buffer>; refus: string[]; racine?: RootRead }> {
  const files = new Map<string, Buffer>();
  const root = join(await realpath(dirname(source)), basename(source));
  let taille = 0;
  let entrees = 0;
  const refuser = (message: string): never => {
    throw new ReadDenial(message);
  };
  const absolute = (rel: string) => (rel ? join(root, rel) : root);
  const verifierDossiers = async (chain: Marker[]): Promise<void> => {
    for (const d of chain) {
      const info = await lstat(absolute(d.chemin)).catch(() => null);
      if (!info?.isDirectory() || info.dev !== d.dev || info.ino !== d.ino) {
        refuser(`Dossier remplacé pendant la lecture : ${d.chemin || "."}`);
      }
    }
  };
  const readTextFile = async (path: string, vu: Marker): Promise<Buffer> => {
    let fh: FileHandle;
    try {
      fh = await open(absolute(path), READ_FLAGS);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (LIENS.has(code)) refuser(`Lien symbolique refusé : ${path}`);
      if (code === "ENOENT") refuser(`Fichier remplacé pendant la lecture : ${path}`);
      throw e;
    }
    try {
      const info = await fh.stat();
      if (!info.isFile() || info.dev !== vu.dev || info.ino !== vu.ino) {
        refuser(`Fichier remplacé pendant la lecture : ${path}`);
      }
      if (info.nlink !== 1) refuser(`Lien physique refusé : ${path}`);
      const rest = TAILLE_MAX - taille;
      const chunks: Buffer[] = [];
      let lu = 0;
      for (;;) {
        const tampon = Buffer.alloc(Math.min(64 * 1024, rest + 1 - lu));
        const { bytesRead } = await fh.read(tampon, 0, tampon.length, null);
        if (bytesRead === 0) break;
        chunks.push(tampon.subarray(0, bytesRead));
        lu += bytesRead;
        if (lu > rest) refuser(`Extension trop lourde : ${TAILLE_MAX / 1024 / 1024} Mo au plus`);
      }
      taille += lu;
      return Buffer.concat(chunks);
    } finally {
      await fh.close();
    }
  };
  const walk = async (chain: Marker[]): Promise<void> => {
    const dossier = chain[chain.length - 1]!;
    let names: string[];
    try {
      names = (await readdir(absolute(dossier.chemin))).sort();
    } catch (e) {
      if (["ENOENT", ...LIENS].includes((e as NodeJS.ErrnoException).code ?? "")) {
        refuser(`Dossier remplacé pendant la lecture : ${dossier.chemin || "."}`);
      }
      throw e;
    }
    await verifierDossiers(chain);
    for (const name of names) {
      const path = dossier.chemin ? `${dossier.chemin}/${name}` : name;
      if (++entrees > ENTREES_MAX) refuser(`Trop d'entrées : ${ENTREES_MAX} fichiers et dossiers au plus`);
      if (path.split("/").length > DEPTH_MAX) refuser(`Arborescence trop profonde : ${DEPTH_MAX} niveaux au plus`);
      const info = await lstat(absolute(path)).catch(() => refuser(`Fichier remplacé pendant la lecture : ${path}`));
      const marker = { chemin: path, dev: info.dev, ino: info.ino };
      if (info.isSymbolicLink()) refuser(`Lien symbolique refusé : ${path}`);
      if (info.isDirectory()) {
        await walk([...chain, marker]);
        continue;
      }
      if (!info.isFile()) refuser(`Fichier spécial refusé : ${path}`);
      if (files.size >= FILES_MAX) refuser(`Trop de fichiers : ${FILES_MAX} au plus`);
      files.set(path, await readTextFile(path, marker));
      await verifierDossiers(chain);
    }
  };
  let lue: RootRead | undefined;
  try {
    const info = await lstat(root);
    if (!info.isDirectory()) refuser("Le dossier de l'extension n'est pas un dossier");
    lue = { chemin: root, dev: info.dev, ino: info.ino };
    await walk([{ chemin: "", dev: info.dev, ino: info.ino }]);
  } catch (e) {
    if (e instanceof ReadDenial) return { fichiers: files, refus: [e.message], ...(lue ? { racine: lue } : {}) };
    throw e;
  }
  return { fichiers: files, refus: [], racine: lue };
}

function hashOf(files: Map<string, Buffer>): string {
  const h = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    const content = files.get(path)!;
    h.update(`${path}\0${content.length}\0`);
    h.update(content);
  }
  return h.digest("hex");
}

/** Static DNR rules declared by the manifest, read among the folder's files (absent if unreadable). */
function reglesDe(manifest: unknown, files: Map<string, Buffer>): Record<string, unknown> {
  const regles: Record<string, unknown> = {};
  const resources = object(object(manifest)?.declarative_net_request)?.rule_resources;
  if (!Array.isArray(resources)) return regles;
  for (const res of resources) {
    const path = object(res)?.path;
    if (typeof path !== "string") continue;
    const content = json(files.get(posix.normalize(path)));
    if (content !== undefined) regles[path] = content;
  }
  return regles;
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
): { refus: string[]; sites: string[] } {
  const denial: string[] = [];
  const sites: string[] = [];
  if (!Array.isArray(manifest.content_scripts)) return { refus: denial, sites };
  const hint = new Map(table.map(([path, genre], i) => [`${genre}:${path}`, i]));
  manifest.content_scripts = manifest.content_scripts.map((cs) => {
    const c = object(cs);
    if (!c) return cs;
    const markers: string[] = [];
    for (const genre of ["css", "js"] as const) {
      if (!Array.isArray(c[genre])) continue;
      for (const brut of c[genre] as unknown[]) {
        const path = typeof brut === "string" ? posix.normalize(brut.replace(/^\/+/, "")) : "";
        const i = hint.get(`${genre}:${path}`);
        if (!path || path.startsWith("..") || i === undefined) denial.push(`Script de contenu introuvable : ${String(brut)}`);
        else markers.push(`${MARKERS}/${i}.js`);
      }
    }
    if (markers.length === 0) return cs;
    for (const m of Array.isArray(c.matches) ? c.matches : []) if (typeof m === "string" && !sites.includes(m)) sites.push(m);
    const { css: _css, ...rest } = c;
    return { ...rest, js: [PAGE_FIXES, PAGE_GUARD, SCOPE, ...markers] };
  });
  return { refus: denial, sites };
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
const MOTS_SVG = ["javascript:", "script", "foreignobject", "<!entity"];

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
  const mot = MOTS_SVG.find((m) => text.includes(m));
  if (mot) return `contient « ${mot} »`;
  if (/\bon[a-z]+\s*=/i.test(text)) return "attribut on…=";
  return null;
}

/** Denials specific to file content: reserved names, non-HTML documents, active SVGs, UTF-16/32 pages. */
function filesDenial(files: Map<string, Buffer>): string[] {
  const denial: string[] = [];
  const reserves = new Set([FOND, ...GUARDS]);
  for (const [path, content] of files) {
    // Any top-level name in « webaios- »: guards, scope, markers (webaios-fichiers/).
    const premier = path.split("/")[0]!.normalize("NFC").toLowerCase();
    if (reserves.has(premier) || premier.startsWith("webaios-")) denial.push(`Nom de fichier réservé à WebAiOs : ${path}`);
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

const FOND_MINIMAL_AGENT = `// Généré par WebAiOs : l'extension n'a pas de fond ; celui-ci, le garde seul, active ses rulesets et onInstalled.\nimportScripts(${JSON.stringify(KEEP_BACKGROUND)});\n`;
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
  cible: string;
  dossierGardes: string;
}): Promise<{ analyse: ManifestAnalysis; empreinte: string; racine?: RootRead }> {
  const { fichiers: files, refus: folderDenial, racine: root } = await lireDossier(o.source);
  const brut = json(files.get("manifest.json"));
  const webaiosBrut = files.get("webaios.json");
  const webaios = webaiosBrut === undefined ? undefined : (json(webaiosBrut) ?? "illisible");
  const messages = messageFiles(brut).map((f) => json(files.get(f)));
  const analyse = parseManifest(brut, { source: "agent", webaios, regles: reglesDe(brut, files), messages });
  analyse.refus = [...folderDenial, ...filesDenial(files), ...analyse.refus];
  const hash = hashOf(files);
  const lue = root ? { racine: root } : {};
  if (analyse.refus.length > 0) return { analyse, empreinte: hash, ...lue };

  const manifest = { ...(brut as Manifest) };
  delete manifest.key;
  delete manifest.update_url;
  manifest.content_security_policy = { extension_pages: cspAgent(analyse.portee.reseau) };
  const scope = `globalThis.__webaiosPortee(${JSON.stringify({ reseau: analyse.portee.reseau, hotes: analyse.portee.hotes })});`;
  const table = fileTable(files);
  const rewritten = rewriteScripts(manifest, table);
  if (rewritten.refus.length > 0) {
    analyse.refus = [...analyse.refus, ...rewritten.refus];
    return { analyse, empreinte: hash, ...lue };
  }
  if (rewritten.sites.length > 0) {
    // The background injects files through `scripting`, which asks for the right and the hosts of the content scripts (already
    // granted: the scope counts these sites). Only the copy carries them, the analysis stays that of the source.
    const permissions = Array.isArray(manifest.permissions) ? (manifest.permissions as unknown[]) : [];
    if (!permissions.includes("scripting")) manifest.permissions = [...permissions, "scripting"];
    const hosts = Array.isArray(manifest.host_permissions) ? (manifest.host_permissions as unknown[]) : [];
    manifest.host_permissions = [...hosts, ...rewritten.sites.filter((x) => !hosts.includes(x))];
  }
  const fond = object(manifest.background);
  let fondJs: string;
  if (fond && typeof fond.service_worker === "string") {
    fondJs = generatedBackground(fond.service_worker, fond.type === "module");
    manifest.background = { ...fond, service_worker: FOND };
  } else {
    // Without a background, nothing would activate its rulesets or fire onInstalled (the guard runs in the background):
    // a minimal background, the guard alone, is declared.
    fondJs = FOND_MINIMAL_AGENT;
    manifest.background = { service_worker: FOND };
  }

  const tmp = `${o.cible}.${randomUUID()}.tmp`;
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
    for (const g of GUARDS) await copyFile(join(o.dossierGardes, g), join(tmp, g));
    // The table at the head of the background guard: it is read before any script of the extension, which can no longer change it.
    await writeFile(
      join(tmp, KEEP_BACKGROUND),
      Buffer.concat([Buffer.from(`const __webaiosFichiers = ${JSON.stringify(table)};\n`), await readFile(join(o.dossierGardes, KEEP_BACKGROUND))]),
    );
    await writeFile(join(tmp, SCOPE), `${scope}\n`);
    await mkdir(join(tmp, MARKERS), { recursive: true });
    for (let i = 0; i < table.length; i++) await writeFile(join(tmp, MARKERS, `${i}.js`), `globalThis.__webaiosFichier(${i});\n`);
    await writeFile(join(tmp, FOND), fondJs);
    await writeFile(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2));
    await replaceFolder(tmp, o.cible);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return { analyse, empreinte: hash, ...lue };
}
