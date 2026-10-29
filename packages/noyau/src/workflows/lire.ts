import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { TAILLE_MAX_WORKFLOW } from "./schema.js";
import { CONTEXTE_PAR_DEFAUT, erreurWorkflow, validerWorkflow, workflowImplicite, type ContexteValidation, type ResultatValidation } from "./valider.js";

export type WorkflowLu = { origine: "fichier" | "implicite"; resultat: ResultatValidation };

/** Le nom existe dans le dossier, même en lien symbolique cassé (un workflow.json cassé est invalide, pas absent). */
export async function existe(chemin: string): Promise<boolean> {
  try {
    await lstat(chemin);
    return true;
  } catch {
    return false;
  }
}

/** Lit workflow.json comme du JSON, sans suivre un lien symbolique qui sortirait du dossier du widget. */
export async function lireBrutWorkflow(dossier: string): Promise<{ brut: unknown } | { erreur: string }> {
  try {
    const [racine, reel] = await Promise.all([realpath(dossier), realpath(join(dossier, "workflow.json"))]);
    if (!reel.startsWith(racine + sep)) return { erreur: "workflow.json sort du dossier du widget" };
    if ((await stat(reel)).size > TAILLE_MAX_WORKFLOW) return { erreur: `workflow.json dépasse ${TAILLE_MAX_WORKFLOW / 1024} Ko` };
    return { brut: JSON.parse(await readFile(reel, "utf8")) };
  } catch (e) {
    // Texte fixe : le message du système citerait des chemins du Mac.
    return { erreur: e instanceof SyntaxError ? "workflow.json illisible (pas du JSON valide)" : "workflow.json illisible" };
  }
}

async function lireFichier(dossier: string, ctx: ContexteValidation): Promise<ResultatValidation> {
  const lu = await lireBrutWorkflow(dossier);
  return "erreur" in lu ? erreurWorkflow(lu.erreur) : validerWorkflow(lu.brut, ctx);
}

/**
 * Le workflow d'un widget : `workflow.json` s'il existe, sinon le workflow implicite d'un
 * `recolte.mjs`, sinon null. Rien n'est exécuté ici : le fichier n'est lu que comme du JSON. `ctx` : ce que le widget
 * déclare (`contexteValidation`).
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
