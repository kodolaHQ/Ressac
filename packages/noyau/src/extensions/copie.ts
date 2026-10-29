import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { analyserManifeste, type AnalyseManifeste } from "./manifeste.js";

/** Dossier des gardes livrés avec le noyau ; un navigateur qui embarque le noyau peut en fournir un autre. */
export const GARDES_PAR_DEFAUT = join(import.meta.dirname, "..", "..", "extensions");

export const FICHIERS_MAX = 2000;
export const TAILLE_MAX = 20 * 1024 * 1024;

const CORRECTIFS_PAGE = "webaios-correctifs-page.js";
const GARDE_PAGE = "webaios-garde-page.js";
const GARDE_FOND = "webaios-garde-fond.js";
const FOND = "webaios-fond.js";
const GARDES = [CORRECTIFS_PAGE, GARDE_PAGE, GARDE_FOND];

export function cspAgent(reseau: readonly string[]): string {
  return (
    "default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'self'" +
    reseau.map((d) => " https://" + d).join("") +
    "; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'none'; frame-ancestors 'self'"
  );
}

type Manifeste = Record<string, unknown>;

function objet(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** JSON d'un fichier (BOM toléré) ; `undefined` s'il est illisible. */
function json(contenu: Buffer | undefined): unknown {
  if (!contenu) return undefined;
  try {
    return JSON.parse(contenu.toString("utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

/**
 * Fichiers ordinaires du dossier (chemins relatifs en `/`), lus sans suivre aucun lien. Un lien symbolique, un
 * fichier spécial, ou un dépassement de `FICHIERS_MAX` / `TAILLE_MAX` donne des refus (le parcours s'arrête).
 */
async function lireDossier(racine: string): Promise<{ fichiers: Map<string, Buffer>; refus: string[] }> {
  const fichiers = new Map<string, Buffer>();
  const refus: string[] = [];
  let taille = 0;
  const parcourir = async (rel: string): Promise<boolean> => {
    const entrees = (await readdir(join(racine, rel))).sort();
    for (const nom of entrees) {
      const chemin = rel ? `${rel}/${nom}` : nom;
      const info = await lstat(join(racine, chemin));
      if (info.isSymbolicLink()) {
        refus.push(`Lien symbolique refusé : ${chemin}`);
        return false;
      }
      if (info.isDirectory()) {
        if (!(await parcourir(chemin))) return false;
        continue;
      }
      if (!info.isFile()) {
        refus.push(`Fichier spécial refusé : ${chemin}`);
        return false;
      }
      if (fichiers.size >= FICHIERS_MAX) {
        refus.push(`Trop de fichiers : ${FICHIERS_MAX} au plus`);
        return false;
      }
      taille += info.size;
      if (taille > TAILLE_MAX) {
        refus.push(`Extension trop lourde : ${TAILLE_MAX / 1024 / 1024} Mo au plus`);
        return false;
      }
      fichiers.set(chemin, await readFile(join(racine, chemin)));
    }
    return true;
  };
  const info = await lstat(racine);
  if (!info.isDirectory()) refus.push("Le dossier de l'extension n'est pas un dossier");
  else await parcourir("");
  return { fichiers, refus };
}

function empreinteDe(fichiers: Map<string, Buffer>): string {
  const h = createHash("sha256");
  for (const chemin of [...fichiers.keys()].sort()) {
    const contenu = fichiers.get(chemin)!;
    h.update(`${chemin}\0${contenu.length}\0`);
    h.update(contenu);
  }
  return h.digest("hex");
}

/** Règles DNR statiques déclarées par le manifeste, lues parmi les fichiers du dossier (absentes si illisibles). */
function reglesDe(manifeste: unknown, fichiers: Map<string, Buffer>): Record<string, unknown> {
  const regles: Record<string, unknown> = {};
  const ressources = objet(objet(manifeste)?.declarative_net_request)?.rule_resources;
  if (!Array.isArray(ressources)) return regles;
  for (const res of ressources) {
    const chemin = objet(res)?.path;
    if (typeof chemin !== "string") continue;
    const contenu = json(fichiers.get(posix.normalize(chemin)));
    if (contenu !== undefined) regles[chemin] = contenu;
  }
  return regles;
}

/** Les scripts donnés en tête de `js` (une seule fois chacun) pour chaque script de contenu qui a du `js`. */
function scriptsEnTete(manifeste: Manifeste, enTete: string[]): void {
  if (!Array.isArray(manifeste.content_scripts)) return;
  for (const cs of manifeste.content_scripts) {
    const c = objet(cs);
    if (!c || !Array.isArray(c.js) || c.js.length === 0) continue;
    c.js = [...enTete, ...c.js.filter((s) => !enTete.includes(s as string))];
  }
}

/** Insère le garde de fond comme premier script d'une page HTML de l'extension. */
function insererGardePage(html: string, chemin: string): string {
  const profondeur = chemin.split("/").length - 1;
  const balise = `<script src="${"../".repeat(profondeur)}${GARDE_FOND}"></script>`;
  const apres = (re: RegExp): number | null => {
    const m = re.exec(html);
    return m ? m.index + m[0].length : null;
  };
  let position =
    apres(/<head(\s[^>]*)?>/i) ?? apres(/<html(\s[^>]*)?>/i) ?? apres(/<!doctype[^>]*>/i) ?? 0;
  // Un script placé avant cet endroit (avant <head>, par exemple) : le garde passe devant lui.
  const premierScript = html.search(/<script[\s>]/i);
  if (premierScript !== -1 && premierScript < position) position = premierScript;
  return html.slice(0, position) + balise + html.slice(position);
}

function fondGenere(original: string, module: boolean): string {
  const chemin = original.replace(/^(\.\/|\/)+/, "");
  const entete = "// Généré par WebAiOs : le garde, puis le service worker de l'extension.\n";
  if (module) return `${entete}import "./${GARDE_FOND}";\nimport ${JSON.stringify("./" + chemin)};\n`;
  return `${entete}importScripts(${JSON.stringify(GARDE_FOND)}, ${JSON.stringify(chemin)});\n`;
}

/** Met `nouveau` à la place de `cible` : deux renommages (un dossier non vide ne se remplace pas d'un coup). */
async function remplacerDossier(nouveau: string, cible: string): Promise<void> {
  const ancien = `${cible}.${randomUUID()}.ancienne`;
  let deplace = false;
  try {
    await rename(cible, ancien);
    deplace = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    await rename(nouveau, cible);
  } catch (e) {
    if (deplace) await rename(ancien, cible).catch(() => undefined);
    throw e;
  }
  if (deplace) await rm(ancien, { recursive: true, force: true });
}

/**
 * Copie contrôlée d'une extension de l'agent : `source` est lu sans suivre aucun lien, analysé, et s'il n'y a
 * aucun refus, la copie (CSP imposée, gardes en tête, `webaios.json`, `key` et `update_url` retirés) remplace
 * `cible` d'un coup. Avec un refus, rien n'est écrit.
 */
export async function preparerCopie(o: {
  source: string;
  cible: string;
  dossierGardes: string;
}): Promise<{ analyse: AnalyseManifeste; empreinte: string }> {
  const { fichiers, refus: refusDossier } = await lireDossier(o.source);
  const brut = json(fichiers.get("manifest.json"));
  const webaiosBrut = fichiers.get("webaios.json");
  const webaios = webaiosBrut === undefined ? undefined : (json(webaiosBrut) ?? "illisible");
  const analyse = analyserManifeste(brut, { source: "agent", webaios, regles: reglesDe(brut, fichiers) });
  const reserves = [...fichiers.keys()].filter((f) => f === FOND || GARDES.includes(f));
  analyse.refus = [
    ...refusDossier,
    ...reserves.map((f) => `Nom de fichier réservé à WebAiOs : ${f}`),
    ...analyse.refus,
  ];
  const empreinte = empreinteDe(fichiers);
  if (analyse.refus.length > 0) return { analyse, empreinte };

  const manifeste = { ...(brut as Manifeste) };
  delete manifeste.key;
  delete manifeste.update_url;
  manifeste.content_security_policy = { extension_pages: cspAgent(analyse.portee.reseau) };
  scriptsEnTete(manifeste, [CORRECTIFS_PAGE, GARDE_PAGE]);
  const fond = objet(manifeste.background);
  let fondJs: string | null = null;
  if (fond && typeof fond.service_worker === "string") {
    fondJs = fondGenere(fond.service_worker, fond.type === "module");
    manifeste.background = { ...fond, service_worker: FOND };
  }

  const tmp = `${o.cible}.${randomUUID()}.tmp`;
  try {
    await mkdir(tmp, { recursive: true });
    for (const [chemin, contenu] of fichiers) {
      if (chemin === "webaios.json" || chemin === "manifest.json") continue;
      const destination = join(tmp, chemin);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(
        destination,
        /\.html?$/i.test(chemin) ? insererGardePage(contenu.toString("utf8"), chemin) : contenu,
      );
    }
    for (const g of GARDES) await copyFile(join(o.dossierGardes, g), join(tmp, g));
    if (fondJs) await writeFile(join(tmp, FOND), fondJs);
    await writeFile(join(tmp, "manifest.json"), JSON.stringify(manifeste, null, 2));
    await remplacerDossier(tmp, o.cible);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return { analyse, empreinte };
}

/** Prépare une extension du Store décompressée : correctif `storage.sync` en tête de ses scripts de contenu (idempotent). */
export async function preparerStore(dossierVersion: string, dossierGardes: string): Promise<void> {
  const chemin = join(dossierVersion, "manifest.json");
  const manifeste = json(await readFile(chemin));
  if (!objet(manifeste)) throw new Error(`Manifeste illisible : ${chemin}`);
  await copyFile(join(dossierGardes, CORRECTIFS_PAGE), join(dossierVersion, CORRECTIFS_PAGE));
  scriptsEnTete(manifeste as Manifeste, [CORRECTIFS_PAGE]);
  await writeFile(chemin, JSON.stringify(manifeste, null, 2));
}
