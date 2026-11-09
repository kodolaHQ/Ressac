import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheminsEspace } from "../chemins.js";
import { existe, lireBrutWorkflow } from "../workflows/lire.js";
import { erreurWorkflow, validerWorkflow, type ContexteValidation, type WorkflowValide } from "../workflows/valider.js";
import { DeclarationAction, ID_ACTION } from "./schemas.js";

export const TAILLE_MAX_ACTION_JSON = 64 * 1024;

export type ActionLue =
  | { id: string; dossier: string; declaration: DeclarationAction; aWorkflow: boolean }
  | { id: string; dossier: string; erreur: string };

const ERREUR_MAX = 300;

async function lireDeclaration(dossier: string): Promise<{ declaration: DeclarationAction } | { erreur: string }> {
  const fichier = join(dossier, "action.json");
  let brut: unknown;
  try {
    const s = await lstat(fichier);
    if (!s.isFile()) return { erreur: "action.json n'est pas un fichier ordinaire" };
    if (s.size > TAILLE_MAX_ACTION_JSON) return { erreur: `action.json dépasse ${TAILLE_MAX_ACTION_JSON / 1024} Ko` };
    brut = JSON.parse(await readFile(fichier, "utf8"));
  } catch (e) {
    // Fixed text: the system's message would quote Mac paths.
    return { erreur: e instanceof SyntaxError ? "action.json illisible (pas du JSON valide)" : "action.json illisible" };
  }
  const r = DeclarationAction.safeParse(brut);
  if (r.success) return { declaration: r.data };
  const p = r.error.issues[0]!;
  const texte = `action.json invalide : ${[...p.path, p.message].join(" : ")}`;
  return { erreur: texte.length > ERREUR_MAX ? texte.slice(0, ERREUR_MAX - 1) + "…" : texte };
}

async function lireUne(c: CheminsEspace, id: string): Promise<ActionLue> {
  const dossier = join(c.actions, id);
  const lu = await lireDeclaration(dossier);
  if ("erreur" in lu) return { id, dossier, erreur: lu.erreur };
  return { id, dossier, declaration: lu.declaration, aWorkflow: await existe(join(dossier, "workflow.json")) };
}

/** Actions on disk, sorted by name; a broken action is reported, it does not prevent reading the others. */
export async function lireActions(c: CheminsEspace): Promise<ActionLue[]> {
  let noms: string[];
  try {
    // `isDirectory` is false for a symbolic link: a link to a folder is ignored.
    noms = (await readdir(c.actions, { withFileTypes: true })).filter((e) => e.isDirectory() && ID_ACTION.test(e.name)).map((e) => e.name).sort();
  } catch {
    return [];
  }
  return Promise.all(noms.map((id) => lireUne(c, id)));
}

/** An action by its id; null if the folder does not exist (or is a symbolic link, or an invalid name). */
export async function lireAction(c: CheminsEspace, id: string): Promise<ActionLue | null> {
  if (!ID_ACTION.test(id)) return null;
  try {
    if (!(await lstat(join(c.actions, id))).isDirectory()) return null;
  } catch {
    return null;
  }
  return lireUne(c, id);
}

/** What the action's declaration changes to the rules of its workflow. */
export function contexteValidationAction(d: DeclarationAction): ContexteValidation {
  return { web: d.sources.web, dureeMaxMinutes: d.dureeMaxMinutes ?? null, proprietaire: "action", saisie: d.saisie !== undefined };
}

/** An action's workflow: `workflow.json` only (no implicit workflow from a `recolte.mjs`). Nothing is run. */
export async function workflowDeLAction(
  a: ActionLue,
): Promise<{ t: "ok"; valide: WorkflowValide } | { t: "invalide" | "illisible"; erreur: string } | { t: "absent" }> {
  if ("erreur" in a) return { t: "illisible", erreur: a.erreur };
  if (!(await existe(join(a.dossier, "workflow.json")))) return { t: "absent" };
  const lu = await lireBrutWorkflow(a.dossier);
  const r = "erreur" in lu ? erreurWorkflow(lu.erreur) : validerWorkflow(lu.brut, contexteValidationAction(a.declaration));
  return r.ok ? { t: "ok", valide: r.valide } : { t: "invalide", erreur: r.erreur };
}
