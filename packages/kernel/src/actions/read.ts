import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpacePaths } from "../paths.js";
import { exists, readRawWorkflow } from "../workflows/read.js";
import { workflowError, validateWorkflow, type ValidationContext, type ValidWorkflow } from "../workflows/validate.js";
import { DeclarationAction, ID_ACTION } from "./schemas.js";

export const ACTION_JSON_MAX_SIZE = 64 * 1024;

export type ReadAction =
  | { id: string; folder: string; declaration: DeclarationAction; hasWorkflow: boolean }
  | { id: string; folder: string; error: string };

const MAX_ERROR = 300;

async function readDeclaration(folder: string): Promise<{ declaration: DeclarationAction } | { error: string }> {
  const file = join(folder, "action.json");
  let raw: unknown;
  try {
    const s = await lstat(file);
    if (!s.isFile()) return { error: "action.json n'est pas un fichier ordinaire" };
    if (s.size > ACTION_JSON_MAX_SIZE) return { error: `action.json dépasse ${ACTION_JSON_MAX_SIZE / 1024} Ko` };
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    // Fixed text: the system's message would quote Mac paths.
    return { error: e instanceof SyntaxError ? "action.json illisible (pas du JSON valide)" : "action.json illisible" };
  }
  const r = DeclarationAction.safeParse(raw);
  if (r.success) return { declaration: r.data };
  const p = r.error.issues[0]!;
  const text = `action.json invalide : ${[...p.path, p.message].join(" : ")}`;
  return { error: text.length > MAX_ERROR ? text.slice(0, MAX_ERROR - 1) + "…" : text };
}

async function readOne(c: SpacePaths, id: string): Promise<ReadAction> {
  const folder = join(c.actions, id);
  const parsed = await readDeclaration(folder);
  if ("error" in parsed) return { id, folder: folder, error: parsed.error };
  return { id, folder: folder, declaration: parsed.declaration, hasWorkflow: await exists(join(folder, "workflow.json")) };
}

/** Actions on disk, sorted by name; a broken action is reported, it does not prevent reading the others. */
export async function readActions(c: SpacePaths): Promise<ReadAction[]> {
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
export async function readAction(c: SpacePaths, id: string): Promise<ReadAction | null> {
  if (!ID_ACTION.test(id)) return null;
  try {
    if (!(await lstat(join(c.actions, id))).isDirectory()) return null;
  } catch {
    return null;
  }
  return readOne(c, id);
}

/** Caps of `readActionCode`, those of the files staged for a run (`Workshop.stageHarvest`): a bigger file never runs. */
const CODE_FILE_MAX = 1024 * 1024;
const CODE_TOTAL_MAX = 4 * 1024 * 1024;

/**
 * The text of the action code in `folder` as a run stages and runs it: its top-level regular files but `data.json` (as
 * `stageHarvest`), never through a link. [] for a missing folder. An agent launch checks the staged copy with it.
 */
export async function readActionCode(folder: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(folder, { withFileTypes: true })).filter((e) => e.isFile() && e.name !== "data.json").map((e) => e.name).sort();
  } catch {
    return [];
  }
  const texts: string[] = [];
  let total = 0;
  for (const name of names) {
    // O_NOFOLLOW: the agent may swap a file for a link to a Mac file between the listing and the read.
    const f = await open(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!f) continue;
    try {
      const { size } = await f.stat();
      if (size > CODE_FILE_MAX || (total += size) > CODE_TOTAL_MAX) continue;
      texts.push(await f.readFile("utf8"));
    } finally {
      await f.close();
    }
  }
  return texts;
}

/** What the action's declaration changes to the rules of its workflow. */
export function actionValidationContext(d: DeclarationAction, locale = "en"): ValidationContext {
  return { web: d.sources.web, maxDurationMinutes: d.maxDurationMinutes ?? null, owner: "action", input: d.input !== undefined, locale: locale };
}

/** An action's workflow: `workflow.json` only (no implicit workflow from a `harvest.mjs`). Nothing is run. */
export async function actionWorkflow(
  a: ReadAction,
  locale = "en",
): Promise<{ t: "ok"; valid: ValidWorkflow; hash: string } | { t: "invalid" | "unreadable"; error: string } | { t: "absent" }> {
  if ("error" in a) return { t: "unreadable", error: a.error };
  if (!(await exists(join(a.folder, "workflow.json")))) return { t: "absent" };
  const parsed = await readRawWorkflow(a.folder, locale);
  if ("error" in parsed) return { t: "invalid", error: workflowError(locale, parsed.error).error };
  const r = validateWorkflow(parsed.raw, actionValidationContext(a.declaration, locale));
  return r.ok ? { t: "ok", valid: r.valid, hash: parsed.hash } : { t: "invalid", error: r.error };
}
