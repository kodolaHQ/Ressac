import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { WORKFLOW_MAX_SIZE } from "./schema.js";
import { DEFAULT_CONTEXT, workflowError, validateWorkflow, implicitWorkflow, type ValidationContext, type ValidationResult } from "./validate.js";

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
export async function readRawWorkflow(folder: string): Promise<{ brut: unknown } | { erreur: string }> {
  try {
    const [root, real] = await Promise.all([realpath(folder), realpath(join(folder, "workflow.json"))]);
    if (!real.startsWith(root + sep)) return { erreur: "workflow.json sort du dossier du widget" };
    if ((await stat(real)).size > WORKFLOW_MAX_SIZE) return { erreur: `workflow.json dépasse ${WORKFLOW_MAX_SIZE / 1024} Ko` };
    return { brut: JSON.parse(await readFile(real, "utf8")) };
  } catch (e) {
    // Fixed text: the system's message would quote Mac paths.
    return { erreur: e instanceof SyntaxError ? "workflow.json illisible (pas du JSON valide)" : "workflow.json illisible" };
  }
}

async function readTextFile(folder: string, ctx: ValidationContext): Promise<ValidationResult> {
  const lu = await readRawWorkflow(folder);
  return "erreur" in lu ? workflowError(lu.erreur) : validateWorkflow(lu.brut, ctx);
}

/**
 * A widget's workflow: `workflow.json` if it exists, otherwise the implicit workflow of a
 * `recolte.mjs`, otherwise null. Nothing is run here: the file is only read as JSON. `ctx`: what the widget
 * declares (`contexteValidation`).
 */
export async function readWorkflow(filesFolder: string, ctx: ValidationContext = DEFAULT_CONTEXT): Promise<WorkflowLu | null> {
  if (await exists(join(filesFolder, "workflow.json"))) {
    return { origine: "fichier", resultat: await readTextFile(filesFolder, ctx) };
  }
  if (await exists(join(filesFolder, "recolte.mjs"))) {
    return { origine: "implicite", resultat: validateWorkflow(implicitWorkflow(), ctx) };
  }
  return null;
}
