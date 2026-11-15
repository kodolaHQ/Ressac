import { mkdirSync, constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { inFolder, readFiles, type ReadFiles } from "../workspace/confined.js";
import { watch } from "chokidar";
import type { SpacePaths } from "../paths.js";
import {
  DeclarationSite,
  SITE_ID_ERROR,
  tweakFileNotFound,
  ID_SITE,
  TWEAK_MAX,
  TWEAKS_MAX_TOTAL,
  SITE_JSON_MAX,
  checkSiteDeclaration,
} from "./schemas.js";

export type SiteRead =
  | { id: string; folder: string; declaration: DeclarationSite; hasHome: boolean }
  | { id: string; folder: string; error: string };
export type TweaksRead = { js: Record<string, string>; css: Record<string, string> };

const MAX_ERROR = 300;
const GROUPING_MS = 150;

/** Reads an ordinary file (never a link: O_NOFOLLOW), at most `max` bytes; fails if it is bigger. */
async function readBound(path: string, max: number): Promise<string> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await f.stat();
    if (!st.isFile()) throw new Error("pas un fichier ordinaire");
    if (st.size > max) throw new Error("trop gros");
    const buffer = Buffer.alloc(max + 1);
    let n = 0;
    while (n <= max) {
      const { bytesRead } = await f.read(buffer, n, max + 1 - n, null);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n > max) throw new Error("trop gros");
    return buffer.subarray(0, n).toString("utf8");
  } finally {
    await f.close();
  }
}

async function readDeclaration(folder: string, o: { localAddresses: boolean }): Promise<{ declaration: DeclarationSite } | { error: string }> {
  const file = join(folder, "site.json");
  let raw: unknown;
  try {
    const s = await lstat(file);
    if (!s.isFile()) return { error: "site.json n'est pas un fichier ordinaire" };
    if (s.size > SITE_JSON_MAX) return { error: `site.json dépasse ${SITE_JSON_MAX / 1024} Ko` };
    raw = JSON.parse((await readBound(file, SITE_JSON_MAX)).replace(/^\uFEFF/, ""));
  } catch (e) {
    if ((e as Error).message === "trop gros") return { error: `site.json dépasse ${SITE_JSON_MAX / 1024} Ko` };
    // Fixed text: the system's message would quote Mac paths.
    return { error: e instanceof SyntaxError ? "site.json illisible (pas du JSON valide)" : "site.json illisible" };
  }
  const r = DeclarationSite.safeParse(raw);
  if (!r.success) {
    const p = r.error.issues[0]!;
    const text = `site.json invalide : ${[...p.path, p.message].join(" : ")}`;
    return { error: text.length > MAX_ERROR ? text.slice(0, MAX_ERROR - 1) + "…" : text };
  }
  const denial = checkSiteDeclaration(r.data, o);
  return denial ? { error: `site.json invalide : ${denial}` } : { declaration: r.data };
}

async function readOne(c: SpacePaths, id: string, o: { localAddresses: boolean }): Promise<SiteRead> {
  const folder = join(c.sites, id);
  if (!ID_SITE.test(id)) return { id, folder: folder, error: SITE_ID_ERROR };
  const parsed = await readDeclaration(folder, o);
  if ("error" in parsed) return { id, folder: folder, error: parsed.error };
  let hasHome = false;
  try {
    hasHome = (await lstat(join(folder, "home", "index.html"))).isFile();
  } catch {
    // no home
  }
  return { id, folder: folder, declaration: parsed.declaration, hasHome: hasHome };
}

/** The site apps on disk, sorted by id; a broken app is reported, it does not prevent reading the others. */
export async function readSites(c: SpacePaths, o: { localAddresses: boolean }): Promise<SiteRead[]> {
  let ids: string[];
  try {
    // `isDirectory` is false for a symbolic link: a link to a folder is ignored.
    ids = (await readdir(c.sites, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return Promise.all(ids.map((id) => readOne(c, id, o)));
}

/** An app by its id; null if the folder does not exist (or is hidden, a symbolic link, an invalid name). */
export async function readSite(c: SpacePaths, id: string, o: { localAddresses: boolean }): Promise<SiteRead | null> {
  if (!id || id.startsWith(".") || /[\\/\0]/.test(id)) return null;
  try {
    if (!(await lstat(join(c.sites, id))).isDirectory()) return null;
  } catch {
    return null;
  }
  return readOne(c, id, o);
}

/** The files cited by the tweaks, read under `tweaks/`: never a link, never outside the folder, bounded. */
export async function readTweaks(s: Extract<SiteRead, { declaration: DeclarationSite }>): Promise<TweaksRead | { error: string }> {
  const wanted: { kind: "js" | "css"; file: string }[] = [];
  for (const kind of ["js", "css"] as const) {
    const listed = new Set(s.declaration.tweaks.flatMap((r) => r[kind]));
    for (const file of listed) wanted.push({ kind, file });
  }
  // One child for every file: it walks into the app's folder, then each one's folders, never through a link (confined.ts).
  const r = await inFolder<ReadFiles>(dirname(s.folder), [basename(s.folder)], readFiles, [wanted.map((w) => `tweaks/${w.file}`), TWEAK_MAX, TWEAKS_MAX_TOTAL]);
  if (!r) return { error: "tweaks : dossier de l'appli introuvable" };
  if ("failed" in r) return { error: tweakFileNotFound(wanted[r.failed]!.file) };
  const output: TweaksRead = { js: {}, css: {} };
  wanted.forEach((w, i) => (output[w.kind][w.file] = r.files[i]!.text));
  return output;
}

/**
 * Calls `rappel(id, quoi)` after each burst of changes: « declaration » (site.json, or the folder itself
 * appearing or disappearing), « tweaks » or « home ». Returns the stop function.
 */
export function watchSites(
  c: SpacePaths,
  callback: (id: string, what: "declaration" | "tweaks" | "home") => void,
): () => Promise<void> {
  mkdirSync(c.sites, { recursive: true });
  const timers = new Map<string, NodeJS.Timeout>();
  const observer = watch(c.sites, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (p) => p.split(/[\\/]/).some((s) => s === "node_modules" || s === ".trash") || p.endsWith(".tmp"),
  });
  observer.on("all", (event, path) => {
    const parts = path.slice(c.sites.length).split(/[\\/]/).filter(Boolean);
    const id = parts[0];
    if (!id || id.startsWith(".")) return;
    let what: "declaration" | "tweaks" | "home" | null = null;
    if (parts.length === 1) what = event === "addDir" || event === "unlinkDir" ? "declaration" : null;
    else if (parts[1] === "site.json" && parts.length === 2) what = "declaration";
    else if (parts[1] === "tweaks") what = "tweaks";
    else if (parts[1] === "home") what = "home";
    if (!what) return;
    const key = `${id}\0${what}`;
    clearTimeout(timers.get(key));
    const q = what;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        callback(id, q);
      }, GROUPING_MS),
    );
  });
  return async () => {
    for (const m of timers.values()) clearTimeout(m);
    timers.clear();
    await observer.close();
  };
}
