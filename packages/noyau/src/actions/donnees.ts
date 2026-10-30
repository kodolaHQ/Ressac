import { lstat, readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CheminsEspace } from "../chemins.js";
import { TAILLE_MAX_DONNEES } from "../workflows/protocole.js";
import { ecrireAtomique, ID_EXECUTION, listerExecutions } from "../workflows/executions.js";
import { avecMemoire, effacerExecutionsEtMemoire } from "../workflows/memoire.js";
import { retirerAccord } from "../widgets/accords.js";
import { ID_ACTION } from "./schemas.js";

/** Le plan de page de Gemma, tel que rangé : le schéma et la validation sont ceux de `pages/plan.ts`. */
export type PlanPage = { blocs: unknown[] };

/** Ce qu'une exécution d'action a rendu : ses résultats, la mise en page choisie pour eux et comment elle l'a été. */
export type ResultatAction = {
  version: 1;
  execution: string;
  saisie: string | null;
  resultats: unknown;
  plan: PlanPage | null;
  secours: boolean;
  vide: boolean;
};

/** Marge au-delà des données du workflow : le plan, la saisie et l'enveloppe. */
export const RESULTAT_MARGE_OCTETS = 256 * 1024;
export const RESULTAT_MAX_OCTETS = TAILLE_MAX_DONNEES + RESULTAT_MARGE_OCTETS;

const FichierResultat = z.object({
  version: z.literal(1),
  execution: z.string(),
  saisie: z.string().nullable(),
  resultats: z.unknown(),
  plan: z.unknown().nullable(),
  secours: z.boolean(),
  vide: z.boolean(),
});

const dossierResultats = (dossierDonnees: string) => join(dossierDonnees, "resultats");

/**
 * `<dossierActions>/<id>/resultats/<execution>.json`, écrit après l'exécution du même id. Ne garde que les résultats
 * dont l'exécution est gardée (essais compris). Trop gros : rien n'est écrit et l'appel échoue.
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
    // dossier disparu entre-temps
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
    return FichierResultat.parse(JSON.parse(await readFile(chemin, "utf8"))) as ResultatAction;
  } catch {
    return null;
  }
}

/** Le résultat de la plus récente vraie exécution (pas un essai) qui en a un. */
export async function dernierResultat(dossierActions: string, id: string): Promise<ResultatAction | null> {
  if (!ID_ACTION.test(id)) return null;
  for (const e of await listerExecutions(join(dossierActions, id))) {
    if (e.essai || e.id.endsWith("-essai")) continue;
    const r = await lireResultat(dossierActions, id, e.id);
    if (r) return r;
  }
  return null;
}

/** Efface exécutions, résultats et mémoire d'une action (accord retiré, action supprimée). */
export async function supprimerDonneesAction(dossierActions: string, id: string): Promise<void> {
  if (!ID_ACTION.test(id)) throw new Error(`id d'action invalide : ${id}`);
  const dossier = join(dossierActions, id);
  await avecMemoire(dossier, async () => {
    await effacerExecutionsEtMemoire(dossier);
    await rm(dossierResultats(dossier), { recursive: true, force: true });
  });
  // Le dossier de l'action part s'il est vide ; ce que WebAiOs n'y a pas mis reste.
  await rmdir(dossier).catch(() => {});
}

/**
 * Au démarrage : pour chaque `<dossierActions>/<id>` sans `~/WebAiOs/actions/<id>` (action supprimée ou mise à la
 * corbeille), données et accord sont effacés. Les actions encore là, et ce qui n'est pas un dossier d'action, restent.
 */
export async function oublierActionsDisparues(c: CheminsEspace, dossierActions: string): Promise<void> {
  let entrees;
  try {
    entrees = await readdir(dossierActions, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entrees) {
    if (!e.isDirectory() || !ID_ACTION.test(e.name)) continue;
    const presente = await lstat(join(c.actions, e.name)).then(() => true, () => false);
    if (presente) continue;
    await supprimerDonneesAction(dossierActions, e.name);
    await retirerAccord(dossierActions, e.name);
  }
}
