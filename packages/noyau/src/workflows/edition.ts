import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { writeAtomic } from "./executions.js";
import { exists, lireBrutWorkflow } from "./lire.js";
import { withMemory, writeMemory, paramsHash, canonicalJson, readMemory } from "./memoire.js";
import { TAILLE_MAX_WORKFLOW } from "./schema.js";
import {
  DEFAULT_CONTEXT,
  workflowError,
  validateWorkflow,
  implicitWorkflow,
  type ValidationContext,
  type ValidationResult,
  type ValidWorkflow,
} from "./valider.js";

// The builder only reads and writes `workflow.json` and the `.mjs` as text: nothing is run here.

export const CODE_MAX_OCTETS = 256 * 1024;
export const CODE_NAME = /^[a-z0-9-]+\.mjs$/;

const WIDGET_NOT_FOUND = "Widget introuvable";

export type DraftRead = {
  origine: "fichier" | "implicite";
  /** null: not JSON, unreadable, over 256 KB, or a link that leaves the folder. */
  brut: unknown | null;
  validation: { ok: true } | { ok: false; erreur: string; bloc?: string };
};

export type SaveResult =
  | { ok: true; ecrit: boolean; memoireEffacee: string[] }
  | { ok: false; erreur: string; bloc?: string };

const resume = (r: ValidationResult): DraftRead["validation"] => (r.ok ? { ok: true } : { ok: false, erreur: r.erreur, ...(r.bloc === undefined ? {} : { bloc: r.bloc }) });

/** The file exists (link only checked by its name) and its real path stays in the folder. */
async function dansLeDossier(dossier: string, name: string): Promise<boolean> {
  try {
    const [root, reel] = await Promise.all([realpath(dossier), realpath(join(dossier, name))]);
    return reel.startsWith(root + sep);
  } catch {
    return false;
  }
}

async function folderExists(dossier: string): Promise<boolean> {
  try {
    return (await stat(dossier)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What the builder opens: `workflow.json` even if invalid, otherwise the implicit one of a `recolte.mjs`, otherwise null.
 * Writes nothing. `ctx`: what the widget declares (`contexteValidation`).
 */
export async function readDraft(filesFolder: string, ctx: ValidationContext = DEFAULT_CONTEXT): Promise<DraftRead | null> {
  if (await exists(join(filesFolder, "workflow.json"))) {
    const lu = await lireBrutWorkflow(filesFolder);
    if ("erreur" in lu) return { origine: "fichier", brut: null, validation: resume(workflowError(lu.erreur)) };
    return { origine: "fichier", brut: lu.brut, validation: resume(validateWorkflow(lu.brut, ctx)) };
  }
  if (await exists(join(filesFolder, "recolte.mjs"))) {
    const brut = implicitWorkflow();
    return { origine: "implicite", brut, validation: resume(validateWorkflow(brut, ctx)) };
  }
  return null;
}

/**
 * The workflow valid in place: the file if it is valid, otherwise the implicit one of a `recolte.mjs`, otherwise none. Validated
 * with the same context as the new one: otherwise, for a `web` or long widget, the old one would look invalid (memory of the
 * changed blocks kept, identical file rewritten).
 */
async function currentWorkflow(dossier: string, ctx: ValidationContext): Promise<ValidWorkflow | null> {
  const l = await readDraft(dossier, ctx);
  if (!l || l.brut === null) return null;
  const r = validateWorkflow(l.brut, ctx);
  return r.ok ? r.valide : null;
}

/**
 * Saves `workflow.json` (atomic write) if the workflow is valid, if the files of its `code` blocks
 * exist and if it differs from the current one. First erases the memory of the blocks whose params change. `contexte`:
 * what the widget declares (`contexteValidation`), the rules from before without it.
 */
export async function saveWorkflow(o: {
  dossierFichiers: string;
  dossierDonnees: string;
  brut: unknown;
  contexte?: ValidationContext;
}): Promise<SaveResult> {
  const context = o.contexte ?? DEFAULT_CONTEXT;
  const r = validateWorkflow(o.brut, context);
  if (!r.ok) return { ok: false, erreur: r.erreur, ...(r.bloc === undefined ? {} : { bloc: r.bloc }) };
  if (!(await folderExists(o.dossierFichiers))) return { ok: false, erreur: WIDGET_NOT_FOUND };

  for (const b of r.valide.workflow.blocs) {
    if (b.type !== "code") continue;
    const source = String(b.parametres.source);
    if (!(await exists(join(o.dossierFichiers, source)))) return { ok: false, erreur: `Non enregistré : fichier ${source} absent`, bloc: b.id };
  }

  const text = JSON.stringify(o.brut, null, 2) + "\n";
  if (Buffer.byteLength(text) > TAILLE_MAX_WORKFLOW) return { ok: false, erreur: `Workflow trop gros : ${TAILLE_MAX_WORKFLOW / 1024} Ko au plus` };
  const target = join(o.dossierFichiers, "workflow.json");
  if ((await exists(target)) && !(await dansLeDossier(o.dossierFichiers, "workflow.json"))) {
    return { ok: false, erreur: "workflow.json sort du dossier du widget" };
  }

  const before = await currentWorkflow(o.dossierFichiers, context);
  if (before && canonicalJson(before.workflow) === canonicalJson(r.valide.workflow)) return { ok: true, ecrit: false, memoireEffacee: [] };

  // The memory of the changed blocks goes before the workflow is written: a run that reads the new workflow necessarily
  // reads the already-erased memory. Only the entries marked with the new settings remain (a run that has
  // already run with them); an entry without a hash (from before the hashes) goes too.
  const erasedMemory = before
    ? await withMemory(o.dossierDonnees, async () => {
        const oldMemory = new Map(before.workflow.blocs.map((b) => [b.id, b]));
        const memory = await readMemory(o.dossierDonnees);
        const effaces: string[] = [];
        for (const b of r.valide.workflow.blocs) {
          const old = oldMemory.get(b.id);
          const entree = memory[b.id];
          if (!old || old.type !== b.type || !entree) continue;
          const fresh = paramsHash(b.parametres);
          if (paramsHash(old.parametres) !== fresh && entree.empreinte !== fresh) {
            delete memory[b.id];
            effaces.push(b.id);
          }
        }
        if (effaces.length > 0) await writeMemory(o.dossierDonnees, memory);
        return effaces;
      })
    : [];

  await writeAtomic(target, text);
  return { ok: true, ecrit: true, memoireEffacee: erasedMemory };
}

const INVALID_NAME = "Nom de fichier invalide";
const TOO_BIG = `Fichier trop gros : ${CODE_MAX_OCTETS / 1024} Ko au plus`;
const SORT_DU_DOSSIER = "Le fichier sort du dossier du widget";

export async function lireCode(filesFolder: string, name: string): Promise<{ texte: string } | { absent: true } | { erreur: string }> {
  if (!CODE_NAME.test(name)) return { erreur: INVALID_NAME };
  const path = join(filesFolder, name);
  if (!(await exists(path))) return { absent: true };
  try {
    if (!(await dansLeDossier(filesFolder, name))) return { erreur: SORT_DU_DOSSIER };
    if ((await stat(path)).size > CODE_MAX_OCTETS) return { erreur: TOO_BIG };
    return { texte: await readFile(path, "utf8") };
  } catch {
    return { erreur: "Fichier illisible" };
  }
}

/** Writes a widget's `.mjs` as is: its content is neither checked nor run. */
export async function storeCode(filesFolder: string, name: string, text: string): Promise<{ ok: true } | { ok: false; erreur: string }> {
  if (!CODE_NAME.test(name)) return { ok: false, erreur: INVALID_NAME };
  if (Buffer.byteLength(text) > CODE_MAX_OCTETS) return { ok: false, erreur: TOO_BIG };
  if (!(await folderExists(filesFolder))) return { ok: false, erreur: WIDGET_NOT_FOUND };
  const path = join(filesFolder, name);
  if ((await exists(path)) && !(await dansLeDossier(filesFolder, name))) return { ok: false, erreur: SORT_DU_DOSSIER };
  try {
    await writeAtomic(path, text);
  } catch {
    return { ok: false, erreur: "Écriture impossible" };
  }
  return { ok: true };
}
