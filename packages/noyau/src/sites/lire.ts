import { mkdirSync } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { watch } from "chokidar";
import type { SpacePaths } from "../chemins.js";
import {
  DeclarationSite,
  SITE_ID_ERROR,
  tweakFileNotFound,
  ID_SITE,
  TWEAK_MAX,
  TWEAKS_MAX_TOTAL,
  SITE_JSON_MAX,
  verifierDeclarationSite,
} from "./schemas.js";

export type SiteLu =
  | { id: string; dossier: string; declaration: DeclarationSite; aAccueil: boolean }
  | { id: string; dossier: string; erreur: string };
export type TweaksRead = { js: Record<string, string>; css: Record<string, string> };

const MAX_ERROR = 300;
const GROUPING_MS = 150;

/** Reads an ordinary file (never a link: O_NOFOLLOW), at most `max` bytes; fails if it is bigger. */
async function lireBorne(path: string, max: number): Promise<string> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await f.stat();
    if (!st.isFile()) throw new Error("pas un fichier ordinaire");
    if (st.size > max) throw new Error("trop gros");
    const tampon = Buffer.alloc(max + 1);
    let n = 0;
    while (n <= max) {
      const { bytesRead } = await f.read(tampon, n, max + 1 - n, null);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n > max) throw new Error("trop gros");
    return tampon.subarray(0, n).toString("utf8");
  } finally {
    await f.close();
  }
}

async function lireDeclaration(dossier: string, o: { adressesLocales: boolean }): Promise<{ declaration: DeclarationSite } | { erreur: string }> {
  const file = join(dossier, "site.json");
  let brut: unknown;
  try {
    const s = await lstat(file);
    if (!s.isFile()) return { erreur: "site.json n'est pas un fichier ordinaire" };
    if (s.size > SITE_JSON_MAX) return { erreur: `site.json dépasse ${SITE_JSON_MAX / 1024} Ko` };
    brut = JSON.parse((await lireBorne(file, SITE_JSON_MAX)).replace(/^\uFEFF/, ""));
  } catch (e) {
    if ((e as Error).message === "trop gros") return { erreur: `site.json dépasse ${SITE_JSON_MAX / 1024} Ko` };
    // Fixed text: the system's message would quote Mac paths.
    return { erreur: e instanceof SyntaxError ? "site.json illisible (pas du JSON valide)" : "site.json illisible" };
  }
  const r = DeclarationSite.safeParse(brut);
  if (!r.success) {
    const p = r.error.issues[0]!;
    const text = `site.json invalide : ${[...p.path, p.message].join(" : ")}`;
    return { erreur: text.length > MAX_ERROR ? text.slice(0, MAX_ERROR - 1) + "…" : text };
  }
  const denial = verifierDeclarationSite(r.data, o);
  return denial ? { erreur: `site.json invalide : ${denial}` } : { declaration: r.data };
}

async function lireUn(c: SpacePaths, id: string, o: { adressesLocales: boolean }): Promise<SiteLu> {
  const dossier = join(c.sites, id);
  if (!ID_SITE.test(id)) return { id, dossier, erreur: SITE_ID_ERROR };
  const lu = await lireDeclaration(dossier, o);
  if ("erreur" in lu) return { id, dossier, erreur: lu.erreur };
  let hasHome = false;
  try {
    hasHome = (await lstat(join(dossier, "accueil", "index.html"))).isFile();
  } catch {
    // no home
  }
  return { id, dossier, declaration: lu.declaration, aAccueil: hasHome };
}

/** The site apps on disk, sorted by id; a broken app is reported, it does not prevent reading the others. */
export async function lireSites(c: SpacePaths, o: { adressesLocales: boolean }): Promise<SiteLu[]> {
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
  return Promise.all(ids.map((id) => lireUn(c, id, o)));
}

/** An app by its id; null if the folder does not exist (or is hidden, a symbolic link, an invalid name). */
export async function lireSite(c: SpacePaths, id: string, o: { adressesLocales: boolean }): Promise<SiteLu | null> {
  if (!id || id.startsWith(".") || /[\\/\0]/.test(id)) return null;
  try {
    if (!(await lstat(join(c.sites, id))).isDirectory()) return null;
  } catch {
    return null;
  }
  return lireUn(c, id, o);
}

/** The files cited by the tweaks, read under `retouches/`: never a link, never outside the folder, bounded. */
export async function readTweaks(s: Extract<SiteLu, { declaration: DeclarationSite }>): Promise<TweaksRead | { erreur: string }> {
  const base = join(s.dossier, "retouches");
  const manque = { erreur: "retouches : dossier de l'appli introuvable" };
  let realRoot: string;
  try {
    // Neither the app's folder nor `retouches/` can be a link (even replaced since the site was read).
    if (!(await lstat(s.dossier)).isDirectory()) return manque;
    const dossierReel = await realpath(s.dossier);
    if (!(await lstat(base)).isDirectory()) throw new Error("pas un dossier");
    realRoot = await realpath(base);
    if (!realRoot.startsWith(dossierReel + sep)) throw new Error("hors du dossier");
  } catch {
    realRoot = "";
  }
  const sortie: TweaksRead = { js: {}, css: {} };
  let total = 0;
  for (const genre of ["js", "css"] as const) {
    const lues = new Set<string>();
    for (const r of s.declaration.retouches) {
      for (const f of r[genre]) {
        if (lues.has(f)) continue;
        lues.add(f);
        const path = join(base, f);
        try {
          const st = await lstat(path);
          if (!st.isFile() || st.size > TWEAK_MAX) throw new Error("refusé");
          if (!realRoot || !(await realpath(path)).startsWith(realRoot + sep)) throw new Error("hors du dossier");
          total += st.size;
          if (total > TWEAKS_MAX_TOTAL) throw new Error("trop gros");
          sortie[genre][f] = await lireBorne(path, TWEAK_MAX);
        } catch {
          return { erreur: tweakFileNotFound(f) };
        }
      }
    }
  }
  return sortie;
}

/**
 * Calls `rappel(id, quoi)` after each burst of changes: « declaration » (site.json, or the folder itself
 * appearing or disappearing), « retouches » or « accueil ». Returns the stop function.
 */
export function watchSites(
  c: SpacePaths,
  rappel: (id: string, what: "declaration" | "retouches" | "accueil") => void,
): () => Promise<void> {
  mkdirSync(c.sites, { recursive: true });
  const timers = new Map<string, NodeJS.Timeout>();
  const observer = watch(c.sites, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (p) => p.split(/[\\/]/).some((s) => s === "node_modules" || s === ".corbeille") || p.endsWith(".tmp"),
  });
  observer.on("all", (event, path) => {
    const parts = path.slice(c.sites.length).split(/[\\/]/).filter(Boolean);
    const id = parts[0];
    if (!id || id.startsWith(".")) return;
    let what: "declaration" | "retouches" | "accueil" | null = null;
    if (parts.length === 1) what = event === "addDir" || event === "unlinkDir" ? "declaration" : null;
    else if (parts[1] === "site.json" && parts.length === 2) what = "declaration";
    else if (parts[1] === "retouches") what = "retouches";
    else if (parts[1] === "accueil") what = "accueil";
    if (!what) return;
    const key = `${id}\0${what}`;
    clearTimeout(timers.get(key));
    const q = what;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        rappel(id, q);
      }, GROUPING_MS),
    );
  });
  return async () => {
    for (const m of timers.values()) clearTimeout(m);
    timers.clear();
    await observer.close();
  };
}
