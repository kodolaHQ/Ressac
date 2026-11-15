import { mkdirSync, constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
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
/**
 * `check`: called with the opened file, after the open (O_NOFOLLOW guards the last part of the path only): refuses a
 * file reached through a folder swapped for a link in the meantime.
 */
async function readBound(path: string, max: number, check?: (opened: Stats) => Promise<boolean>): Promise<string> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await f.stat();
    if (!st.isFile()) throw new Error("pas un fichier ordinaire");
    if (check && !(await check(st))) throw new Error("dossier changé");
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

/** Every folder from `folder` down to `path` is still a real folder (no link), and `path` still names the opened file. */
async function stillReal(folder: string, path: string, opened: Stats): Promise<boolean> {
  const parts = relative(folder, path).split(sep);
  if (parts.includes("..")) return false;
  let p = folder;
  for (const part of ["", ...parts.slice(0, -1)]) {
    p = join(p, part);
    if (!(await lstat(p)).isDirectory()) return false;
  }
  const entry = await lstat(path);
  return entry.dev === opened.dev && entry.ino === opened.ino;
}

/** The files cited by the tweaks, read under `tweaks/`: never a link, never outside the folder, bounded. */
export async function readTweaks(s: Extract<SiteRead, { declaration: DeclarationSite }>): Promise<TweaksRead | { error: string }> {
  const base = join(s.folder, "tweaks");
  const missing = { error: "tweaks : dossier de l'appli introuvable" };
  let realRoot: string;
  try {
    // Neither the app's folder nor `tweaks/` can be a link (even replaced since the site was read).
    if (!(await lstat(s.folder)).isDirectory()) return missing;
    const realFolder = await realpath(s.folder);
    if (!(await lstat(base)).isDirectory()) throw new Error("pas un dossier");
    realRoot = await realpath(base);
    if (!realRoot.startsWith(realFolder + sep)) throw new Error("hors du dossier");
  } catch {
    realRoot = "";
  }
  const output: TweaksRead = { js: {}, css: {} };
  let total = 0;
  for (const kind of ["js", "css"] as const) {
    const alreadyRead = new Set<string>();
    for (const r of s.declaration.tweaks) {
      for (const f of r[kind]) {
        if (alreadyRead.has(f)) continue;
        alreadyRead.add(f);
        const path = join(base, f);
        try {
          const st = await lstat(path);
          if (!st.isFile() || st.size > TWEAK_MAX) throw new Error("refusé");
          if (!realRoot || !(await realpath(path)).startsWith(realRoot + sep)) throw new Error("hors du dossier");
          total += st.size;
          if (total > TWEAKS_MAX_TOTAL) throw new Error("trop gros");
          output[kind][f] = await readBound(path, TWEAK_MAX, (opened) => stillReal(s.folder, path, opened));
        } catch {
          return { error: tweakFileNotFound(f) };
        }
      }
    }
  }
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
