import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { say } from "../i18n.js";
import { writeAtomic } from "./executions.js";
import { exists, readRawWorkflow } from "./read.js";
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


export type DraftRead = {
  origin: "file" | "implicit";
  /** null: not JSON, unreadable, over 256 KB, or a link that leaves the folder. */
  raw: unknown | null;
  validation: { ok: true } | { ok: false; error: string; block?: string };
};

export type SaveResult =
  | { ok: true; written: boolean; memoryErased: string[] }
  | { ok: false; error: string; block?: string };

const resume = (r: ValidationResult): DraftRead["validation"] => (r.ok ? { ok: true } : { ok: false, error: r.error, ...(r.block === undefined ? {} : { block: r.block }) });

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
 * What the builder opens: `workflow.json` even if invalid, otherwise the implicit one of a `harvest.mjs`, otherwise null.
 * Writes nothing. `ctx`: what the widget declares (`contexteValidation`).
 */
export async function readDraft(filesFolder: string, ctx: ValidationContext = DEFAULT_CONTEXT): Promise<DraftRead | null> {
  if (await exists(join(filesFolder, "workflow.json"))) {
    const parsed = await readRawWorkflow(filesFolder, ctx.locale);
    if ("error" in parsed) return { origin: "file", raw: null, validation: resume(workflowError(ctx.locale ?? "en", parsed.error)) };
    return { origin: "file", raw: parsed.raw, validation: resume(validateWorkflow(parsed.raw, ctx)) };
  }
  if (await exists(join(filesFolder, "harvest.mjs"))) {
    const raw = implicitWorkflow();
    return { origin: "implicit", raw: raw, validation: resume(validateWorkflow(raw, ctx)) };
  }
  return null;
}

/**
 * The workflow valid in place: the file if it is valid, otherwise the implicit one of a `harvest.mjs`, otherwise none. Validated
 * with the same context as the new one: otherwise, for a `web` or long widget, the old one would look invalid (memory of the
 * changed blocks kept, identical file rewritten).
 */
async function currentWorkflow(folder: string, ctx: ValidationContext): Promise<ValidWorkflow | null> {
  const l = await readDraft(folder, ctx);
  if (!l || l.raw === null) return null;
  const r = validateWorkflow(l.raw, ctx);
  return r.ok ? r.valid : null;
}

/**
 * Saves `workflow.json` (atomic write) if the workflow is valid, if the files of its `code` blocks
 * exist and if it differs from the current one. First erases the memory of the blocks whose params change. `contexte`:
 * what the widget declares (`contexteValidation`), the rules from before without it.
 */
export async function saveWorkflow(o: {
  filesFolder: string;
  dataFolder: string;
  raw: unknown;
  context?: ValidationContext;
}): Promise<SaveResult> {
  const context = o.context ?? DEFAULT_CONTEXT;
  const locale = context.locale ?? "en";
  const r = validateWorkflow(o.raw, context);
  if (!r.ok) return { ok: false, error: r.error, ...(r.block === undefined ? {} : { block: r.block }) };
  if (!(await folderExists(o.filesFolder))) return { ok: false, error: say(locale, "workflows-save-widget-not-found") };

  for (const b of r.valid.workflow.blocks) {
    if (b.type !== "code") continue;
    const source = String(b.params.source);
    if (!(await exists(join(o.filesFolder, source)))) return { ok: false, error: say(locale, "workflows-save-code-absent", { source }), block: b.id };
  }

  const text = JSON.stringify(o.raw, null, 2) + "\n";
  if (Buffer.byteLength(text) > WORKFLOW_MAX_SIZE) return { ok: false, error: say(locale, "workflows-save-too-big", { kb: String(WORKFLOW_MAX_SIZE / 1024) }) };
  const target = join(o.filesFolder, "workflow.json");
  if ((await exists(target)) && !(await inFolder(o.filesFolder, "workflow.json"))) {
    return { ok: false, error: say(locale, "workflows-file-leaves-folder") };
  }

  const before = await currentWorkflow(o.filesFolder, context);
  if (before && canonicalJson(before.workflow) === canonicalJson(r.valid.workflow)) return { ok: true, written: false, memoryErased: [] };

  // The memory of the changed blocks goes before the workflow is written: a run that reads the new workflow necessarily
  // reads the already-erased memory. Only the entries marked with the new settings remain (a run that has
  // already run with them); an entry without a hash (from before the hashes) goes too.
  const erasedMemory = before
    ? await withMemory(o.dataFolder, async () => {
        const oldMemory = new Map(before.workflow.blocks.map((b) => [b.id, b]));
        const memory = await readMemory(o.dataFolder);
        const erased: string[] = [];
        for (const b of r.valid.workflow.blocks) {
          const old = oldMemory.get(b.id);
          const entry = memory[b.id];
          if (!old || old.type !== b.type || !entry) continue;
          const fresh = paramsHash(b.params);
          if (paramsHash(old.params) !== fresh && entry.hash !== fresh) {
            delete memory[b.id];
            erased.push(b.id);
          }
        }
        if (erased.length > 0) await writeMemory(o.dataFolder, memory);
        return erased;
      })
    : [];

  await writeAtomic(target, text);
  return { ok: true, written: true, memoryErased: erasedMemory };
}

const tooBig = (locale: string) => say(locale, "workflows-code-too-big", { kb: String(CODE_MAX_BYTES / 1024) });

export async function readCodeFile(filesFolder: string, name: string, locale = "en"): Promise<{ text: string } | { absent: true } | { error: string }> {
  if (!CODE_NAME.test(name)) return { error: say(locale, "workflows-code-invalid-name") };
  const path = join(filesFolder, name);
  if (!(await exists(path))) return { absent: true };
  try {
    if (!(await inFolder(filesFolder, name))) return { error: say(locale, "workflows-code-leaves-folder") };
    if ((await stat(path)).size > CODE_MAX_BYTES) return { error: tooBig(locale) };
    return { text: await readFile(path, "utf8") };
  } catch {
    return { error: say(locale, "workflows-code-unreadable") };
  }
}

/** Writes a widget's `.mjs` as is: its content is neither checked nor run. */
export async function storeCode(filesFolder: string, name: string, text: string, locale = "en"): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!CODE_NAME.test(name)) return { ok: false, error: say(locale, "workflows-code-invalid-name") };
  if (Buffer.byteLength(text) > CODE_MAX_BYTES) return { ok: false, error: tooBig(locale) };
  if (!(await folderExists(filesFolder))) return { ok: false, error: say(locale, "workflows-save-widget-not-found") };
  const path = join(filesFolder, name);
  if ((await exists(path)) && !(await inFolder(filesFolder, name))) return { ok: false, error: say(locale, "workflows-code-leaves-folder") };
  try {
    await writeAtomic(path, text);
  } catch {
    return { ok: false, error: say(locale, "workflows-code-write-failed") };
  }
  return { ok: true };
}
