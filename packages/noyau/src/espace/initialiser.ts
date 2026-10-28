import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CheminsEspace } from "../chemins.js";

/** Dossier des modèles du paquet ; un navigateur qui embarque le noyau peut en fournir un autre. */
export const MODELES_PAR_DEFAUT = join(import.meta.dirname, "..", "..", "modeles");

/**
 * Empreintes sha256 des anciennes versions du modèle AGENTS.md. Un AGENTS.md qui en a une est resté tel
 * quel : il est remplacé par le modèle courant. À compléter à chaque nouvelle version du modèle.
 */
const ANCIENS_AGENTS = new Set([
  "4cb44a141c2e0865ae472910b3f1026b918c2d09d12b96732b7a5556ffcc4681",
  "fc35b4b096def3e0850796b6bf784947adb2092aad8f71da879865891fbb7a27",
  "3117019dee9b14b0cc47dd8aa33edcfbf8f476a9ea521479c15e7a0c1004eca1",
  "00d106e8d934a49848c9e30f569127b2ccbdde91954a98e9fad1c0914b7d822b",
  "6e43cefaf3f1ad8f07dacf4165f66a360e1fd0c3cf3a54c9920de42be25b7ba7",
  "f71dc1f75c8ba571083b9c0929a9d3a07cd31e9918e3686367a43998bf8d0ef8",
  "96e9af1e85b74650b58471fa4433c30d37334adf40d448a0469bec5e3bc16a55",
  "6a12cecc4b6cc13e6fd26f2ec50fda3e3d6381421644e1e5c81d897a3c4ba5c3",
]);

async function agentsRestePourAncien(chemin: string): Promise<boolean> {
  try {
    return ANCIENS_AGENTS.has(createHash("sha256").update(await readFile(chemin)).digest("hex"));
  } catch {
    return false;
  }
}

/** Horodatage ISO sans « : » (valable comme nom de dossier). */
function horodatage(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

async function renommerSiPresent(de: string, vers: string): Promise<void> {
  try {
    await rename(de, vers);
  } catch (e) {
    // Absent, ou déjà déplacé par un lancement simultané : rien à faire.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** Un `disposition.json` qui n'est pas au format v2 (ancien `{ ordre }`). Illisible : laissé en place. */
async function dispositionAncienne(chemin: string): Promise<boolean> {
  try {
    const v: unknown = JSON.parse(await readFile(chemin, "utf8"));
    return typeof v !== "object" || v === null || (v as { version?: unknown }).version !== 2;
  } catch {
    return false;
  }
}

/** Les anciens blocs et l'ancienne disposition sont mis de côté dans `accueil/.corbeille/blocs-<horodatage>`, jamais détruits. */
async function mettreDeCoteLesBlocs(c: CheminsEspace): Promise<void> {
  const blocs = existsSync(c.blocs);
  const dispo = existsSync(c.disposition) && (await dispositionAncienne(c.disposition));
  if (!blocs && !dispo) return;
  const cible = join(c.accueil, ".corbeille", `blocs-${horodatage()}`);
  await mkdir(dirname(cible), { recursive: true });
  if (blocs) await renommerSiPresent(c.blocs, cible);
  if (dispo) {
    await mkdir(cible, { recursive: true });
    await renommerSiPresent(c.disposition, join(cible, "disposition.json"));
  }
}

async function fichiersDe(dossier: string, prefixe = ""): Promise<string[]> {
  const sortie: string[] = [];
  for (const e of await readdir(dossier, { withFileTypes: true })) {
    const rel = join(prefixe, e.name);
    if (e.isDirectory()) sortie.push(...(await fichiersDe(join(dossier, e.name), rel)));
    else sortie.push(rel);
  }
  return sortie;
}

/**
 * Fichier modèle → destination dans l'espace. Les widgets de départ ne sont posés que si `accueil/widgets/`
 * n'existe pas : un widget supprimé par l'utilisateur ne doit pas revenir.
 */
async function correspondances(c: CheminsEspace, modeles: string): Promise<[string, string][]> {
  const paires: [string, string][] = [
    ["AGENTS.md", join(c.racine, "AGENTS.md")],
    ["CLAUDE.md", join(c.racine, "CLAUDE.md")],
    ["profil-claude.json", join(c.profils, "claude.json")],
    ["disposition.json", c.disposition],
  ];
  if (!existsSync(c.widgets)) {
    for (const f of await fichiersDe(join(modeles, "widgets"))) paires.push([join("widgets", f), join(c.widgets, f)]);
  }
  return paires;
}

/** Crée l'espace de travail à partir des modèles, sans écraser un fichier existant (sauf un AGENTS.md d'un ancien modèle). */
export async function initialiserEspace(c: CheminsEspace, modeles = MODELES_PAR_DEFAUT): Promise<{ crees: string[] }> {
  const crees: string[] = [];
  await mettreDeCoteLesBlocs(c);
  for (const [modele, destination] of await correspondances(c, modeles)) {
    const miseAJour = modele === "AGENTS.md" && (await agentsRestePourAncien(destination));
    if (existsSync(destination) && !miseAJour) continue;
    await mkdir(dirname(destination), { recursive: true });
    try {
      // COPYFILE_EXCL : si le fichier apparaît entre-temps, on ne l'écrase pas.
      await copyFile(join(modeles, modele), destination, miseAJour ? 0 : constants.COPYFILE_EXCL);
      crees.push(destination);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  await mkdir(c.projets, { recursive: true });
  return { crees };
}
