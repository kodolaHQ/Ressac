import { mkdirSync } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { watch } from "chokidar";
import type { CheminsEspace } from "../chemins.js";
import {
  DeclarationSite,
  ERREUR_ID_SITE,
  fichierRetoucheIntrouvable,
  ID_SITE,
  RETOUCHE_MAX,
  RETOUCHES_MAX_TOTAL,
  SITE_JSON_MAX,
  verifierDeclarationSite,
} from "./schemas.js";

export type SiteLu =
  | { id: string; dossier: string; declaration: DeclarationSite; aAccueil: boolean }
  | { id: string; dossier: string; erreur: string };
export type RetouchesLues = { js: Record<string, string>; css: Record<string, string> };

const ERREUR_MAX = 300;
const REGROUPEMENT_MS = 150;

/** Lit un fichier ordinaire (jamais un lien : O_NOFOLLOW), au plus `max` octets ; échoue s'il est plus gros. */
async function lireBorne(chemin: string, max: number): Promise<string> {
  const f = await open(chemin, constants.O_RDONLY | constants.O_NOFOLLOW);
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
  const fichier = join(dossier, "site.json");
  let brut: unknown;
  try {
    const s = await lstat(fichier);
    if (!s.isFile()) return { erreur: "site.json n'est pas un fichier ordinaire" };
    if (s.size > SITE_JSON_MAX) return { erreur: `site.json dépasse ${SITE_JSON_MAX / 1024} Ko` };
    brut = JSON.parse((await lireBorne(fichier, SITE_JSON_MAX)).replace(/^\uFEFF/, ""));
  } catch (e) {
    if ((e as Error).message === "trop gros") return { erreur: `site.json dépasse ${SITE_JSON_MAX / 1024} Ko` };
    // Texte fixe : le message du système citerait des chemins du Mac.
    return { erreur: e instanceof SyntaxError ? "site.json illisible (pas du JSON valide)" : "site.json illisible" };
  }
  const r = DeclarationSite.safeParse(brut);
  if (!r.success) {
    const p = r.error.issues[0]!;
    const texte = `site.json invalide : ${[...p.path, p.message].join(" : ")}`;
    return { erreur: texte.length > ERREUR_MAX ? texte.slice(0, ERREUR_MAX - 1) + "…" : texte };
  }
  const refus = verifierDeclarationSite(r.data, o);
  return refus ? { erreur: `site.json invalide : ${refus}` } : { declaration: r.data };
}

async function lireUn(c: CheminsEspace, id: string, o: { adressesLocales: boolean }): Promise<SiteLu> {
  const dossier = join(c.sites, id);
  if (!ID_SITE.test(id)) return { id, dossier, erreur: ERREUR_ID_SITE };
  const lu = await lireDeclaration(dossier, o);
  if ("erreur" in lu) return { id, dossier, erreur: lu.erreur };
  let aAccueil = false;
  try {
    aAccueil = (await lstat(join(dossier, "accueil", "index.html"))).isFile();
  } catch {
    // pas d'accueil
  }
  return { id, dossier, declaration: lu.declaration, aAccueil };
}

/** Les applis de site du disque, triées par id ; une appli cassée est signalée, elle n'empêche pas de lire les autres. */
export async function lireSites(c: CheminsEspace, o: { adressesLocales: boolean }): Promise<SiteLu[]> {
  let ids: string[];
  try {
    // `isDirectory` est faux pour un lien symbolique : un lien vers un dossier est ignoré.
    ids = (await readdir(c.sites, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return Promise.all(ids.map((id) => lireUn(c, id, o)));
}

/** Une appli par son id ; null si le dossier n'existe pas (ou est caché, un lien symbolique, un nom invalide). */
export async function lireSite(c: CheminsEspace, id: string, o: { adressesLocales: boolean }): Promise<SiteLu | null> {
  if (!id || id.startsWith(".") || /[\\/\0]/.test(id)) return null;
  try {
    if (!(await lstat(join(c.sites, id))).isDirectory()) return null;
  } catch {
    return null;
  }
  return lireUn(c, id, o);
}

/** Les fichiers cités par les retouches, lus sous `retouches/` : jamais un lien, jamais hors du dossier, bornés. */
export async function lireRetouches(s: Extract<SiteLu, { declaration: DeclarationSite }>): Promise<RetouchesLues | { erreur: string }> {
  const base = join(s.dossier, "retouches");
  const manque = { erreur: "retouches : dossier de l'appli introuvable" };
  let racineReelle: string;
  try {
    // Ni le dossier de l'appli ni `retouches/` ne peuvent être un lien (même remplacé depuis la lecture du site).
    if (!(await lstat(s.dossier)).isDirectory()) return manque;
    const dossierReel = await realpath(s.dossier);
    if (!(await lstat(base)).isDirectory()) throw new Error("pas un dossier");
    racineReelle = await realpath(base);
    if (!racineReelle.startsWith(dossierReel + sep)) throw new Error("hors du dossier");
  } catch {
    racineReelle = "";
  }
  const sortie: RetouchesLues = { js: {}, css: {} };
  let total = 0;
  for (const genre of ["js", "css"] as const) {
    const lues = new Set<string>();
    for (const r of s.declaration.retouches) {
      for (const f of r[genre]) {
        if (lues.has(f)) continue;
        lues.add(f);
        const chemin = join(base, f);
        try {
          const st = await lstat(chemin);
          if (!st.isFile() || st.size > RETOUCHE_MAX) throw new Error("refusé");
          if (!racineReelle || !(await realpath(chemin)).startsWith(racineReelle + sep)) throw new Error("hors du dossier");
          total += st.size;
          if (total > RETOUCHES_MAX_TOTAL) throw new Error("trop gros");
          sortie[genre][f] = await lireBorne(chemin, RETOUCHE_MAX);
        } catch {
          return { erreur: fichierRetoucheIntrouvable(f) };
        }
      }
    }
  }
  return sortie;
}

/**
 * Appelle `rappel(id, quoi)` après chaque rafale de changements : « declaration » (site.json, ou le dossier lui-même
 * qui apparaît ou disparaît), « retouches » ou « accueil ». Renvoie la fonction d'arrêt.
 */
export function surveillerSites(
  c: CheminsEspace,
  rappel: (id: string, quoi: "declaration" | "retouches" | "accueil") => void,
): () => Promise<void> {
  mkdirSync(c.sites, { recursive: true });
  const minuteries = new Map<string, NodeJS.Timeout>();
  const observateur = watch(c.sites, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (p) => p.split(/[\\/]/).some((s) => s === "node_modules" || s === ".corbeille") || p.endsWith(".tmp"),
  });
  observateur.on("all", (evenement, chemin) => {
    const parts = chemin.slice(c.sites.length).split(/[\\/]/).filter(Boolean);
    const id = parts[0];
    if (!id || id.startsWith(".")) return;
    let quoi: "declaration" | "retouches" | "accueil" | null = null;
    if (parts.length === 1) quoi = evenement === "addDir" || evenement === "unlinkDir" ? "declaration" : null;
    else if (parts[1] === "site.json" && parts.length === 2) quoi = "declaration";
    else if (parts[1] === "retouches") quoi = "retouches";
    else if (parts[1] === "accueil") quoi = "accueil";
    if (!quoi) return;
    const cle = `${id}\0${quoi}`;
    clearTimeout(minuteries.get(cle));
    const q = quoi;
    minuteries.set(
      cle,
      setTimeout(() => {
        minuteries.delete(cle);
        rappel(id, q);
      }, REGROUPEMENT_MS),
    );
  });
  return async () => {
    for (const m of minuteries.values()) clearTimeout(m);
    minuteries.clear();
    await observateur.close();
  };
}
