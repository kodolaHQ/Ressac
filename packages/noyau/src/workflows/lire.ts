import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { TAILLE_MAX_WORKFLOW } from "./schema.js";
import { erreurWorkflow, validerWorkflow, workflowImplicite, type ResultatValidation } from "./valider.js";

export type WorkflowLu = { origine: "fichier" | "implicite"; resultat: ResultatValidation };

/** Le nom existe dans le dossier, même en lien symbolique cassé (un workflow.json cassé est invalide, pas absent). */
async function existe(chemin: string): Promise<boolean> {
  try {
    await lstat(chemin);
    return true;
  } catch {
    return false;
  }
}

/** Lit workflow.json comme du JSON, sans suivre un lien symbolique qui sortirait du dossier du widget. */
async function lireFichier(dossier: string): Promise<ResultatValidation> {
  try {
    const [racine, reel] = await Promise.all([realpath(dossier), realpath(join(dossier, "workflow.json"))]);
    if (!reel.startsWith(racine + sep)) return erreurWorkflow("workflow.json sort du dossier du widget");
    if ((await stat(reel)).size > TAILLE_MAX_WORKFLOW) {
      return erreurWorkflow(`workflow.json dépasse ${TAILLE_MAX_WORKFLOW / 1024} Ko`);
    }
    return validerWorkflow(JSON.parse(await readFile(reel, "utf8")));
  } catch (e) {
    // Texte fixe : le message du système citerait des chemins du Mac.
    return erreurWorkflow(e instanceof SyntaxError ? "workflow.json illisible (pas du JSON valide)" : "workflow.json illisible");
  }
}

/**
 * Le workflow d'un widget : `workflow.json` s'il existe, sinon le workflow implicite d'un
 * `recolte.mjs`, sinon null. Rien n'est exécuté ici : le fichier n'est lu que comme du JSON.
 */
export async function lireWorkflow(dossierFichiers: string): Promise<WorkflowLu | null> {
  if (await existe(join(dossierFichiers, "workflow.json"))) {
    return { origine: "fichier", resultat: await lireFichier(dossierFichiers) };
  }
  if (await existe(join(dossierFichiers, "recolte.mjs"))) {
    return { origine: "implicite", resultat: validerWorkflow(workflowImplicite()) };
  }
  return null;
}
