import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { effacerExecutionsEtMemoire } from "../workflows/memoire.js";
import { ETAT_WIDGET_PAR_DEFAUT, EtatWidget, TAILLE_MAX_DONNEES } from "./schemas.js";

// A temporary name specific to each write: two simultaneous writes (a grant denied during a harvest)
// do not trample each other.
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

/** Harvested data of a widget, or null if absent, damaged or too big (over 2 MB). */
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

/** Erases the harvested data, runs and block memory (for example when an account's grant is withdrawn). */
export async function supprimerDonnees(dossierWidgets: string, id: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`id de widget invalide : ${id}`);
  await rm(join(dossierWidgets, id, "donnees.json"), { force: true });
  await effacerExecutionsEtMemoire(join(dossierWidgets, id));
}

export async function lireEtatWidget(dossierWidgets: string, id: string): Promise<EtatWidget> {
  try {
    return EtatWidget.parse(JSON.parse(await readFile(join(dossierWidgets, id, "etat.json"), "utf8")));
  } catch {
    // etat.json absent or damaged: start again from the default state.
    return { ...ETAT_WIDGET_PAR_DEFAUT };
  }
}

/** Per widget, the last write of its state: the next one waits for it (each re-reads what it keeps). */
const ecrituresEtat = new Map<string, Promise<unknown>>();

function sousVerrouEtat<T>(dossierWidgets: string, id: string, f: () => Promise<T>): Promise<T> {
  const cle = join(dossierWidgets, id);
  const tache = (ecrituresEtat.get(cle) ?? Promise.resolve()).then(f);
  const fin = tache.catch(() => {});
  ecrituresEtat.set(cle, fin);
  void fin.then(() => {
    if (ecrituresEtat.get(cle) === fin) ecrituresEtat.delete(cle);
  });
  return tache;
}

async function ecrireEtatSansVerrou(dossierWidgets: string, id: string, etat: EtatWidget): Promise<void> {
  // Hour tracking survives all state writes (running, error, grant, workshop stopped).
  const final = etat.heures ? etat : { ...etat, ...(await heuresActuelles(dossierWidgets, id)) };
  await ecrireAtomique(join(dossierWidgets, id, "etat.json"), JSON.stringify(final, null, 2));
}

/** Writes of a widget's state go one after the other: none loses another's hour tracking. */
export function ecrireEtatWidget(dossierWidgets: string, id: string, etat: EtatWidget): Promise<void> {
  return sousVerrouEtat(dossierWidgets, id, () => ecrireEtatSansVerrou(dossierWidgets, id, etat));
}

/**
 * Re-reads the widget's state and writes what `f` makes of it, with no other write of its state slipping in between
 * the two. `f` returns null: nothing is written. Returns the written state (or null).
 */
export function modifierEtatWidget(dossierWidgets: string, id: string, f: (etat: EtatWidget) => EtatWidget | null): Promise<EtatWidget | null> {
  return sousVerrouEtat(dossierWidgets, id, async () => {
    const etat = f(await lireEtatWidget(dossierWidgets, id));
    if (etat) await ecrireEtatSansVerrou(dossierWidgets, id, etat);
    return etat;
  });
}

async function heuresActuelles(dossierWidgets: string, id: string): Promise<Pick<EtatWidget, "heures">> {
  const { heures } = await lireEtatWidget(dossierWidgets, id);
  return heures ? { heures } : {};
}
