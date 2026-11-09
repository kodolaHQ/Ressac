import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { TAILLE_MAX_WORKFLOW } from "./schema.js";
import { CONTEXTE_PAR_DEFAUT, erreurWorkflow, validerWorkflow, workflowImplicite, type ContexteValidation, type ResultatValidation } from "./valider.js";

export type WorkflowLu = { origine: "fichier" | "implicite"; resultat: ResultatValidation };

/** The name exists in the folder, even as a broken symbolic link (a broken workflow.json is invalid, not absent). */
export async function existe(chemin: string): Promise<boolean> {
  try {
    await lstat(chemin);
    return true;
  } catch {
    return false;
  }
}

/** Reads workflow.json as JSON, without following a symbolic link that would leave the widget's folder. */
export async function lireBrutWorkflow(dossier: string): Promise<{ brut: unknown } | { erreur: string }> {
  try {
    const [racine, reel] = await Promise.all([realpath(dossier), realpath(join(dossier, "workflow.json"))]);
    if (!reel.startsWith(racine + sep)) return { erreur: "workflow.json sort du dossier du widget" };
    if ((await stat(reel)).size > TAILLE_MAX_WORKFLOW) return { erreur: `workflow.json dépasse ${TAILLE_MAX_WORKFLOW / 1024} Ko` };
    return { brut: JSON.parse(await readFile(reel, "utf8")) };
  } catch (e) {
    // Fixed text: the system's message would quote Mac paths.
    return { erreur: e instanceof SyntaxError ? "workflow.json illisible (pas du JSON valide)" : "workflow.json illisible" };
  }
}

async function lireFichier(dossier: string, ctx: ContexteValidation): Promise<ResultatValidation> {
  const lu = await lireBrutWorkflow(dossier);
  return "erreur" in lu ? erreurWorkflow(lu.erreur) : validerWorkflow(lu.brut, ctx);
}

/**
 * A widget's workflow: `workflow.json` if it exists, otherwise the implicit workflow of a
 * `recolte.mjs`, otherwise null. Nothing is run here: the file is only read as JSON. `ctx`: what the widget
 * declares (`contexteValidation`).
 */
export async function lireWorkflow(dossierFichiers: string, ctx: ContexteValidation = CONTEXTE_PAR_DEFAUT): Promise<WorkflowLu | null> {
  if (await existe(join(dossierFichiers, "workflow.json"))) {
    return { origine: "fichier", resultat: await lireFichier(dossierFichiers, ctx) };
  }
  if (await existe(join(dossierFichiers, "recolte.mjs"))) {
    return { origine: "implicite", resultat: validerWorkflow(workflowImplicite(), ctx) };
  }
  return null;
}
