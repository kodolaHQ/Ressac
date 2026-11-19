import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { say } from "../i18n.js";
import { WORKFLOW_MAX_SIZE } from "./schema.js";
import { DEFAULT_CONTEXT, workflowError, validateWorkflow, implicitWorkflow, type ValidationContext, type ValidationResult } from "./validate.js";

/** `hash`: sha256 of the workflow.json bytes parsed (null for the implicit workflow): the run checks the staged copy against it. */
export type WorkflowRead = { origin: "file" | "implicit"; result: ValidationResult; hash: string | null };

/** The sha256 of a workflow.json's bytes: what was parsed must be what was staged (WorkflowContext.workflowHash). */
export const workflowBytesHash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

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
export async function readRawWorkflow(folder: string, locale = "en"): Promise<{ raw: unknown; hash: string } | { error: string }> {
  try {
    const [root, real] = await Promise.all([realpath(folder), realpath(join(folder, "workflow.json"))]);
    if (!real.startsWith(root + sep)) return { error: say(locale, "workflows-file-leaves-folder") };
    if ((await stat(real)).size > WORKFLOW_MAX_SIZE) return { error: say(locale, "workflows-file-too-big", { kb: String(WORKFLOW_MAX_SIZE / 1024) }) };
    const bytes = await readFile(real);
    return { raw: JSON.parse(bytes.toString("utf8")), hash: workflowBytesHash(bytes) };
  } catch (e) {
    // Fixed text: the system's message would quote Mac paths.
    return { error: say(locale, e instanceof SyntaxError ? "workflows-file-bad-json" : "workflows-file-unreadable") };
  }
}

async function readTextFile(folder: string, ctx: ValidationContext): Promise<WorkflowRead> {
  const parsed = await readRawWorkflow(folder, ctx.locale);
  return "error" in parsed ? { origin: "file", result: workflowError(ctx.locale ?? "en", parsed.error), hash: null } : { origin: "file", result: validateWorkflow(parsed.raw, ctx), hash: parsed.hash };
}

/**
 * A widget's workflow: `workflow.json` if it exists, otherwise the implicit workflow of a
 * `harvest.mjs`, otherwise null. Nothing is run here: the file is only read as JSON. `ctx`: what the widget
 * declares (`contexteValidation`).
 */
export async function readWorkflow(filesFolder: string, ctx: ValidationContext = DEFAULT_CONTEXT): Promise<WorkflowRead | null> {
  if (await exists(join(filesFolder, "workflow.json"))) {
    return readTextFile(filesFolder, ctx);
  }
  if (await exists(join(filesFolder, "harvest.mjs"))) {
    return { origin: "implicit", result: validateWorkflow(implicitWorkflow(), ctx), hash: null };
  }
  return null;
}
