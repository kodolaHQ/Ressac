import { constants } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CheminsEspace } from "../chemins.js";

/** Dossier des modèles du paquet ; un navigateur qui embarque le noyau peut en fournir un autre. */
export const MODELES_PAR_DEFAUT = join(import.meta.dirname, "..", "..", "modeles");

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

/** Crée l'espace de travail à partir des modèles, sans jamais écraser un fichier existant. */
export async function initialiserEspace(c: CheminsEspace, modeles = MODELES_PAR_DEFAUT): Promise<{ crees: string[] }> {
  const crees: string[] = [];
  for (const [modele, destination] of await correspondances(c, modeles)) {
    if (existsSync(destination)) continue;
    await mkdir(dirname(destination), { recursive: true });
    try {
      // COPYFILE_EXCL : si le fichier apparaît entre-temps, on ne l'écrase pas.
      await copyFile(join(modeles, modele), destination, constants.COPYFILE_EXCL);
      crees.push(destination);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  await mkdir(c.projets, { recursive: true });
  return { crees };
}
