import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
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
]);

async function agentsRestePourAncien(chemin: string): Promise<boolean> {
  try {
    return ANCIENS_AGENTS.has(createHash("sha256").update(await readFile(chemin)).digest("hex"));
  } catch {
    return false;
  }
}

/**
 * Fichier modèle → destination dans l'espace. Le contenu de départ de la page d'accueil n'est posé
 * qu'au premier lancement (dossier `accueil/` absent) : un bloc supprimé par l'utilisateur ne doit pas revenir.
 */
async function correspondances(c: CheminsEspace, modeles: string): Promise<[string, string][]> {
  const paires: [string, string][] = [
    ["AGENTS.md", join(c.racine, "AGENTS.md")],
    ["CLAUDE.md", join(c.racine, "CLAUDE.md")],
    ["profil-claude.json", join(c.profils, "claude.json")],
  ];
  if (existsSync(c.accueil)) return paires;
  paires.push(["disposition.json", c.disposition]);
  for (const bloc of await readdir(join(modeles, "blocs"))) {
    for (const f of await readdir(join(modeles, "blocs", bloc))) {
      paires.push([join("blocs", bloc, f), join(c.blocs, bloc, f)]);
    }
  }
  return paires;
}

/** Crée l'espace de travail à partir des modèles, sans écraser un fichier existant (sauf un AGENTS.md d'un ancien modèle). */
export async function initialiserEspace(c: CheminsEspace, modeles = MODELES_PAR_DEFAUT): Promise<{ crees: string[] }> {
  const crees: string[] = [];
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
