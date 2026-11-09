import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { writeAtomic } from "./executions.js";
import { exists, readRawWorkflow } from "./lire.js";
import { withMemory, writeMemory, paramsHash, canonicalJson, readMemory } from "./memory.js";
import { WORKFLOW_MAX_SIZE } from "./schema.js";
import {
  DEFAULT_CONTEXT,
  workflowError,
  validateWorkflow,
  implicitWorkflow,
  type ValidationContext,
  type ValidationResult,
  type ValidWorkflow,
} from "./validate.js";

// The builder only reads and writes `workflow.json` and the `.mjs` as text: nothing is run here.

export const CODE_MAX_BYTES = 256 * 1024;
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
async function inFolder(folder: string, name: string): Promise<boolean> {
  try {
    const [root, real] = await Promise.all([realpath(folder), realpath(join(folder, name))]);
    return real.startsWith(root + sep);
  } catch {
    return false;
  }
}

async function folderExists(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
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
    const lu = await readRawWorkflow(filesFolder);
    if ("erreur" in lu) return { origine: "fichier", brut: null, validation: resume(workflowError(lu.erreur)) };
    return { origine: "fichier", brut: lu.brut, validation: resume(validateWorkflow(lu.brut, ctx)) };
  }
  if (await exists(join(filesFolder, "recolte.mjs"))) {
    const raw = implicitWorkflow();
    return { origine: "implicite", brut: raw, validation: resume(validateWorkflow(raw, ctx)) };
  }
  return null;
}

/**
 * The workflow valid in place: the file if it is valid, otherwise the implicit one of a `recolte.mjs`, otherwise none. Validated
 * with the same context as the new one: otherwise, for a `web` or long widget, the old one would look invalid (memory of the
 * changed blocks kept, identical file rewritten).
 */
async function currentWorkflow(folder: string, ctx: ValidationContext): Promise<ValidWorkflow | null> {
  const l = await readDraft(folder, ctx);
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
  if (Buffer.byteLength(text) > WORKFLOW_MAX_SIZE) return { ok: false, erreur: `Workflow trop gros : ${WORKFLOW_MAX_SIZE / 1024} Ko au plus` };
  const target = join(o.dossierFichiers, "workflow.json");
  if ((await exists(target)) && !(await inFolder(o.dossierFichiers, "workflow.json"))) {
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
        const erased: string[] = [];
        for (const b of r.valide.workflow.blocs) {
          const old = oldMemory.get(b.id);
          const entry = memory[b.id];
          if (!old || old.type !== b.type || !entry) continue;
          const fresh = paramsHash(b.parametres);
          if (paramsHash(old.parametres) !== fresh && entry.empreinte !== fresh) {
            delete memory[b.id];
            erased.push(b.id);
          }
        }
        if (erased.length > 0) await writeMemory(o.dossierDonnees, memory);
        return erased;
      })
    : [];

  await writeAtomic(target, text);
  return { ok: true, ecrit: true, memoireEffacee: erasedMemory };
}

const INVALID_NAME = "Nom de fichier invalide";
const TOO_BIG = `Fichier trop gros : ${CODE_MAX_BYTES / 1024} Ko au plus`;
const LEAVES_FOLDER = "Le fichier sort du dossier du widget";

export async function readCodeFile(filesFolder: string, name: string): Promise<{ texte: string } | { absent: true } | { erreur: string }> {
  if (!CODE_NAME.test(name)) return { erreur: INVALID_NAME };
  const path = join(filesFolder, name);
  if (!(await exists(path))) return { absent: true };
  try {
    if (!(await inFolder(filesFolder, name))) return { erreur: LEAVES_FOLDER };
    if ((await stat(path)).size > CODE_MAX_BYTES) return { erreur: TOO_BIG };
    return { texte: await readFile(path, "utf8") };
  } catch {
    return { erreur: "Fichier illisible" };
  }
}

/** Writes a widget's `.mjs` as is: its content is neither checked nor run. */
export async function storeCode(filesFolder: string, name: string, text: string): Promise<{ ok: true } | { ok: false; erreur: string }> {
  if (!CODE_NAME.test(name)) return { ok: false, erreur: INVALID_NAME };
  if (Buffer.byteLength(text) > CODE_MAX_BYTES) return { ok: false, erreur: TOO_BIG };
  if (!(await folderExists(filesFolder))) return { ok: false, erreur: WIDGET_NOT_FOUND };
  const path = join(filesFolder, name);
  if ((await exists(path)) && !(await inFolder(filesFolder, name))) return { ok: false, erreur: LEAVES_FOLDER };
  try {
    await writeAtomic(path, text);
  } catch {
    return { ok: false, erreur: "Écriture impossible" };
  }
  return { ok: true };
}
