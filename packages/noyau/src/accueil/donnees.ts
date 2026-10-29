import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { effacerExecutionsEtMemoire } from "../workflows/memoire.js";
import { ETAT_WIDGET_PAR_DEFAUT, EtatWidget, TAILLE_MAX_DONNEES } from "./schemas.js";

// Un nom temporaire propre à chaque écriture : deux écritures simultanées (refus d'un accord pendant une récolte)
// ne se marchent pas dessus.
async function ecrireAtomique(cible: string, texte: string): Promise<void> {
  await mkdir(join(cible, ".."), { recursive: true });
  const temporaire = `${cible}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaire, texte);
    await rename(temporaire, cible);
  } finally {
    await rm(temporaire, { force: true });
  }
}

/** Données récoltées d'un widget, ou null si absentes, abîmées ou trop grosses (plus de 2 Mo). */
export async function lireDonnees(dossierWidgets: string, id: string): Promise<unknown | null> {
  const chemin = join(dossierWidgets, id, "donnees.json");
  try {
    if ((await stat(chemin)).size > TAILLE_MAX_DONNEES) return null;
    return JSON.parse(await readFile(chemin, "utf8"));
  } catch {
    return null;
  }
}

export async function ecrireDonnees(dossierWidgets: string, id: string, donnees: unknown): Promise<void> {
  const texte = JSON.stringify(donnees ?? null);
  if (Buffer.byteLength(texte) > TAILLE_MAX_DONNEES) throw new Error("Données trop grosses (2 Mo au plus)");
  await ecrireAtomique(join(dossierWidgets, id, "donnees.json"), texte);
}

/** Efface les données récoltées, les exécutions et la mémoire des blocs (par exemple quand l'accord d'un compte est retiré). */
export async function supprimerDonnees(dossierWidgets: string, id: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`id de widget invalide : ${id}`);
  await rm(join(dossierWidgets, id, "donnees.json"), { force: true });
  await effacerExecutionsEtMemoire(join(dossierWidgets, id));
}

export async function lireEtatWidget(dossierWidgets: string, id: string): Promise<EtatWidget> {
  try {
    return EtatWidget.parse(JSON.parse(await readFile(join(dossierWidgets, id, "etat.json"), "utf8")));
  } catch {
    // etat.json absent ou abîmé : on repart de l'état par défaut.
    return { ...ETAT_WIDGET_PAR_DEFAUT };
  }
}

export async function ecrireEtatWidget(dossierWidgets: string, id: string, etat: EtatWidget): Promise<void> {
  // Le suivi des heures survit à toutes les écritures d'état (en-cours, erreur, accord, atelier arrêté).
  const final = etat.heures ? etat : { ...etat, ...(await heuresActuelles(dossierWidgets, id)) };
  await ecrireAtomique(join(dossierWidgets, id, "etat.json"), JSON.stringify(final, null, 2));
}

async function heuresActuelles(dossierWidgets: string, id: string): Promise<Pick<EtatWidget, "heures">> {
  const { heures } = await lireEtatWidget(dossierWidgets, id);
  return heures ? { heures } : {};
}
