import { lstat, readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CheminsEspace } from "../chemins.js";
import { TAILLE_MAX_DONNEES } from "../workflows/protocole.js";
import { ecrireAtomique, ID_EXECUTION, listerExecutions } from "../workflows/executions.js";
import { avecMemoire, effacerExecutionsEtMemoire } from "../workflows/memoire.js";
import { retirerAccord } from "../widgets/accords.js";
import { PlanPage } from "../pages/plan.js";
import { ID_ACTION } from "./schemas.js";

/** What an action run returned: its results, the layout chosen for them and how it was chosen. */
export type ResultatAction = {
  version: 1;
  execution: string;
  saisie: string | null;
  resultats: unknown;
  plan: PlanPage | null;
  secours: boolean;
  vide: boolean;
};

/** Margin beyond the workflow's data: the plan, the input and the envelope. */
export const RESULTAT_MARGE_OCTETS = 256 * 1024;
export const RESULTAT_MAX_OCTETS = TAILLE_MAX_DONNEES + RESULTAT_MARGE_OCTETS;

const FichierResultat = z.object({
  version: z.literal(1),
  execution: z.string(),
  saisie: z.string().nullable(),
  resultats: z.unknown(),
  plan: PlanPage.nullable(),
  secours: z.boolean(),
  vide: z.boolean(),
});

const dossierResultats = (dossierDonnees: string) => join(dossierDonnees, "resultats");

/**
 * `<actionsFolder>/<id>/resultats/<run>.json`, written after the run of the same id. Keeps only the results
 * of runs that are kept (trials included). Too big: nothing is written and the call fails.
 */
export async function ecrireResultat(dossierActions: string, id: string, r: ResultatAction): Promise<void> {
  if (!ID_ACTION.test(id)) throw new Error(`id d'action invalide : ${id}`);
  if (!ID_EXECUTION.test(r.execution)) throw new Error(`id d'exécution invalide : ${r.execution}`);
  const texte = JSON.stringify(r);
  if (Buffer.byteLength(texte) > RESULTAT_MAX_OCTETS) throw new Error("résultat trop gros");
  const dossierDonnees = join(dossierActions, id);
  const dossier = dossierResultats(dossierDonnees);
  await ecrireAtomique(join(dossier, `${r.execution}.json`), texte);
  const gardees = new Set((await listerExecutions(dossierDonnees)).map((e) => e.id));
  gardees.add(r.execution);
  let noms: string[] = [];
  try {
    noms = await readdir(dossier);
  } catch {
    // folder gone in the meantime
  }
  for (const nom of noms) {
    if (nom.endsWith(".json") && !gardees.has(nom.slice(0, -5))) await rm(join(dossier, nom), { force: true });
  }
}

export async function lireResultat(dossierActions: string, id: string, execution: string): Promise<ResultatAction | null> {
  if (!ID_ACTION.test(id) || !ID_EXECUTION.test(execution)) return null;
  try {
    const chemin = join(dossierResultats(join(dossierActions, id)), `${execution}.json`);
    if ((await stat(chemin)).size > RESULTAT_MAX_OCTETS) return null;
    return FichierResultat.parse(JSON.parse(await readFile(chemin, "utf8"))) satisfies ResultatAction;
  } catch {
    return null;
  }
}

/** The result of the most recent real run (not a trial) that has one. */
export async function dernierResultat(dossierActions: string, id: string): Promise<ResultatAction | null> {
  if (!ID_ACTION.test(id)) return null;
  for (const e of await listerExecutions(join(dossierActions, id))) {
    if (e.essai || e.id.endsWith("-essai")) continue;
    const r = await lireResultat(dossierActions, id, e.id);
    if (r) return r;
  }
  return null;
}

/** Erases runs, results and memory of an action (grant withdrawn, action deleted). */
export async function supprimerDonneesAction(dossierActions: string, id: string): Promise<void> {
  if (!ID_ACTION.test(id)) throw new Error(`id d'action invalide : ${id}`);
  const dossier = join(dossierActions, id);
  await avecMemoire(dossier, async () => {
    await effacerExecutionsEtMemoire(dossier);
    await rm(dossierResultats(dossier), { recursive: true, force: true });
  });
  // The action's folder goes if empty; what WebAiOs did not put there stays.
  await rmdir(dossier).catch(() => {});
}

/**
 * At startup: for each `<actionsFolder>/<id>` without `~/WebAiOs/actions/<id>` (action deleted or put in the
 * trash), data and grant are erased. Actions still there, and what is not an action folder, stay.
 */
export async function oublierActionsDisparues(c: CheminsEspace, dossierActions: string): Promise<void> {
  let entrees;
  try {
    // Actions folder not found (workspace moved, volume unmounted): nothing is known, nothing is erased.
    if (!(await stat(c.actions)).isDirectory()) return;
    await readdir(c.actions);
    entrees = await readdir(dossierActions, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entrees) {
    if (!e.isDirectory() || !ID_ACTION.test(e.name)) continue;
    const presente = await lstat(join(c.actions, e.name)).then((s) => s.isDirectory(), () => false);
    if (presente) continue;
    await supprimerDonneesAction(dossierActions, e.name);
    await retirerAccord(dossierActions, e.name);
  }
}
