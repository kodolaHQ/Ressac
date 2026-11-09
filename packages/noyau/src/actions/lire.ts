import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpacePaths } from "../chemins.js";
import { exists, lireBrutWorkflow } from "../workflows/lire.js";
import { workflowError, validateWorkflow, type ValidationContext, type ValidWorkflow } from "../workflows/valider.js";
import { DeclarationAction, ID_ACTION } from "./schemas.js";

export const TAILLE_MAX_ACTION_JSON = 64 * 1024;

export type ActionLue =
  | { id: string; dossier: string; declaration: DeclarationAction; aWorkflow: boolean }
  | { id: string; dossier: string; erreur: string };

const MAX_ERROR = 300;

async function lireDeclaration(dossier: string): Promise<{ declaration: DeclarationAction } | { erreur: string }> {
  const file = join(dossier, "action.json");
  let brut: unknown;
  try {
    const s = await lstat(file);
    if (!s.isFile()) return { erreur: "action.json n'est pas un fichier ordinaire" };
    if (s.size > TAILLE_MAX_ACTION_JSON) return { erreur: `action.json dépasse ${TAILLE_MAX_ACTION_JSON / 1024} Ko` };
    brut = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    // Fixed text: the system's message would quote Mac paths.
    return { erreur: e instanceof SyntaxError ? "action.json illisible (pas du JSON valide)" : "action.json illisible" };
  }
  const r = DeclarationAction.safeParse(brut);
  if (r.success) return { declaration: r.data };
  const p = r.error.issues[0]!;
  const text = `action.json invalide : ${[...p.path, p.message].join(" : ")}`;
  return { erreur: text.length > MAX_ERROR ? text.slice(0, MAX_ERROR - 1) + "…" : text };
}

async function readOne(c: SpacePaths, id: string): Promise<ActionLue> {
  const dossier = join(c.actions, id);
  const lu = await lireDeclaration(dossier);
  if ("erreur" in lu) return { id, dossier, erreur: lu.erreur };
  return { id, dossier, declaration: lu.declaration, aWorkflow: await exists(join(dossier, "workflow.json")) };
}

/** Actions on disk, sorted by name; a broken action is reported, it does not prevent reading the others. */
export async function lireActions(c: SpacePaths): Promise<ActionLue[]> {
  let names: string[];
  try {
    // `isDirectory` is false for a symbolic link: a link to a folder is ignored.
    names = (await readdir(c.actions, { withFileTypes: true })).filter((e) => e.isDirectory() && ID_ACTION.test(e.name)).map((e) => e.name).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map((id) => readOne(c, id)));
}

/** An action by its id; null if the folder does not exist (or is a symbolic link, or an invalid name). */
export async function lireAction(c: SpacePaths, id: string): Promise<ActionLue | null> {
  if (!ID_ACTION.test(id)) return null;
  try {
    if (!(await lstat(join(c.actions, id))).isDirectory()) return null;
  } catch {
    return null;
  }
  return readOne(c, id);
}

/** What the action's declaration changes to the rules of its workflow. */
export function actionValidationContext(d: DeclarationAction): ValidationContext {
  return { web: d.sources.web, dureeMaxMinutes: d.dureeMaxMinutes ?? null, proprietaire: "action", saisie: d.saisie !== undefined };
}

/** An action's workflow: `workflow.json` only (no implicit workflow from a `recolte.mjs`). Nothing is run. */
export async function workflowDeLAction(
  a: ActionLue,
): Promise<{ t: "ok"; valide: ValidWorkflow } | { t: "invalide" | "illisible"; erreur: string } | { t: "absent" }> {
  if ("erreur" in a) return { t: "illisible", erreur: a.erreur };
  if (!(await exists(join(a.dossier, "workflow.json")))) return { t: "absent" };
  const lu = await lireBrutWorkflow(a.dossier);
  const r = "erreur" in lu ? workflowError(lu.erreur) : validateWorkflow(lu.brut, actionValidationContext(a.declaration));
  return r.ok ? { t: "ok", valide: r.valide } : { t: "invalide", erreur: r.erreur };
}
