import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheminsEspace } from "../chemins.js";
import { ConfigBloc, Disposition, ETAT_PAR_DEFAUT, EtatBloc, type BlocLu, type EtatAccueil } from "./schemas.js";

async function lireJson(chemin: string): Promise<unknown> {
  return JSON.parse(await readFile(chemin, "utf8"));
}

async function lireBloc(c: CheminsEspace, id: string): Promise<BlocLu> {
  const dossier = join(c.blocs, id);
  let config: ConfigBloc;
  try {
    config = ConfigBloc.parse(await lireJson(join(dossier, "bloc.json")));
  } catch (e) {
    return { id, dossier, erreur: `bloc.json invalide : ${(e as Error).message}` };
  }
  let etat = ETAT_PAR_DEFAUT;
  try {
    etat = EtatBloc.parse(await lireJson(join(dossier, "etat.json")));
  } catch {
    // etat.json absent ou abîmé : on repart de l'état par défaut.
  }
  const html = join(dossier, "index.html");
  const cheminHtml = config.type === "agent" && existsSync(html) ? html : null;
  return { id, dossier, config, etat, cheminHtml };
}

async function lireOrdre(c: CheminsEspace): Promise<string[]> {
  try {
    return Disposition.parse(await lireJson(c.disposition)).ordre;
  } catch {
    return [];
  }
}

/** Lit la page d'accueil. Un bloc cassé est signalé, il n'empêche pas de lire les autres. */
export async function lireAccueil(c: CheminsEspace): Promise<EtatAccueil> {
  if (!existsSync(c.blocs)) return { ordre: [], blocs: [] };
  const ids = (await readdir(c.blocs, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const voulus = (await lireOrdre(c)).filter((id) => ids.includes(id));
  const ordre = [...new Set(voulus), ...ids.filter((id) => !voulus.includes(id))];
  return { ordre, blocs: await Promise.all(ordre.map((id) => lireBloc(c, id))) };
}

export async function ecrireEtatBloc(c: CheminsEspace, id: string, etat: EtatBloc): Promise<void> {
  const cible = join(c.blocs, id, "etat.json");
  const temporaire = `${cible}.${process.pid}.tmp`;
  await writeFile(temporaire, JSON.stringify(etat, null, 2));
  await rename(temporaire, cible);
}
