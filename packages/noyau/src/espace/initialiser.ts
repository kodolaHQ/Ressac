import { copyFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CheminsEspace } from "../chemins.js";

const MODELES = join(import.meta.dirname, "..", "..", "modeles");

/** Fichier modèle → destination dans l'espace. */
async function correspondances(c: CheminsEspace): Promise<[string, string][]> {
  const paires: [string, string][] = [
    ["AGENTS.md", join(c.racine, "AGENTS.md")],
    ["CLAUDE.md", join(c.racine, "CLAUDE.md")],
    ["disposition.json", c.disposition],
    ["profil-claude.json", join(c.profils, "claude.json")],
  ];
  for (const bloc of await readdir(join(MODELES, "blocs"))) {
    for (const f of await readdir(join(MODELES, "blocs", bloc))) {
      paires.push([join("blocs", bloc, f), join(c.blocs, bloc, f)]);
    }
  }
  return paires;
}

/** Crée l'espace de travail à partir des modèles, sans jamais écraser un fichier existant. */
export async function initialiserEspace(c: CheminsEspace): Promise<{ crees: string[] }> {
  const crees: string[] = [];
  for (const [modele, destination] of await correspondances(c)) {
    if (existsSync(destination)) continue;
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(MODELES, modele), destination);
    crees.push(destination);
  }
  await mkdir(c.projets, { recursive: true });
  return { crees };
}
