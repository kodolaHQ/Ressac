import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { TAILLE_MAX_WORKFLOW } from "./schema.js";
import { DEFAULT_CONTEXT, workflowError, validateWorkflow, implicitWorkflow, type ValidationContext, type ValidationResult } from "./valider.js";

export type WorkflowLu = { origine: "fichier" | "implicite"; resultat: ValidationResult };

/** The name exists in the folder, even as a broken symbolic link (a broken workflow.json is invalid, not absent). */
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Reads workflow.json as JSON, without following a symbolic link that would leave the widget's folder. */
export async function lireBrutWorkflow(dossier: string): Promise<{ brut: unknown } | { erreur: string }> {
  try {
    const [root, reel] = await Promise.all([realpath(dossier), realpath(join(dossier, "workflow.json"))]);
    if (!reel.startsWith(root + sep)) return { erreur: "workflow.json sort du dossier du widget" };
    if ((await stat(reel)).size > TAILLE_MAX_WORKFLOW) return { erreur: `workflow.json dépasse ${TAILLE_MAX_WORKFLOW / 1024} Ko` };
    return { brut: JSON.parse(await readFile(reel, "utf8")) };
  } catch (e) {
    // Fixed text: the system's message would quote Mac paths.
    return { erreur: e instanceof SyntaxError ? "workflow.json illisible (pas du JSON valide)" : "workflow.json illisible" };
  }
}

async function readTextFile(dossier: string, ctx: ValidationContext): Promise<ValidationResult> {
  const lu = await lireBrutWorkflow(dossier);
  return "erreur" in lu ? workflowError(lu.erreur) : validateWorkflow(lu.brut, ctx);
}

/**
 * A widget's workflow: `workflow.json` if it exists, otherwise the implicit workflow of a
 * `recolte.mjs`, otherwise null. Nothing is run here: the file is only read as JSON. `ctx`: what the widget
 * declares (`contexteValidation`).
 */
export async function lireWorkflow(filesFolder: string, ctx: ValidationContext = DEFAULT_CONTEXT): Promise<WorkflowLu | null> {
  if (await exists(join(filesFolder, "workflow.json"))) {
    return { origine: "fichier", resultat: await readTextFile(filesFolder, ctx) };
  }
  if (await exists(join(filesFolder, "recolte.mjs"))) {
    return { origine: "implicite", resultat: validateWorkflow(implicitWorkflow(), ctx) };
  }
  return null;
}
