import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  ACTION_UNKNOWN,
  warnWorkflow,
  validationContext,
  actionValidationContext,
  DeclarationWidget,
  storeCode,
  saveWorkflow,
  readAction,
  readDraft,
  readCodeFile,
  validateWorkflow,
  type Warning,
  type DeclarationAction,
  type SpacePaths,
  type SaveResult,
  type OpenWorkflow,
} from "../../../packages/kernel/src/index.ts";
import { workflowUrlTarget } from "../shared/model.ts";
import type { WorkflowEdit, BuilderSelection } from "../shared/api.ts";

// The widget and action parts of the workflow builder.

/**
 * What the agent may know of a window's builder: only whether its active tab is `ressac://workflow/<widget>` or
 * `ressac://workflow/action/<action>`; the block only if the selection is on that very workflow.
 */
export function workflowOpen(activeUrl: string | undefined, selection: BuilderSelection | undefined): OpenWorkflow | null {
  const target = activeUrl ? workflowUrlTarget(activeUrl) : null;
  if (!target) return null;
  const s = selection;
  if (target.type === "widget") return { widget: target.id, block: s && "widget" in s && s.widget === target.id ? s.block : null };
  return { action: target.id, block: s && "action" in s && s.action === target.id ? s.block : null };
}

/** Writes of one widget one after the other (saves and code), different widgets in parallel. */
export class WriteQueue {
  private queues = new Map<string, Promise<unknown>>();

  inSeries<T>(key: string, f: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.then(f, f);
    const end = current.catch(() => undefined);
    this.queues.set(key, end);
    void end.then(() => {
      if (this.queues.get(key) === end) this.queues.delete(key);
    });
    return current;
  }
}

type Context = { paths: SpacePaths; widgetsFolder: string };

const UNREADABLE_MESSAGE = "Écriture impossible";

/**
 * The widget's folder, or null: the widgets folder must not be a link, the widget folder must be a real folder (not a
 * link) inside it. The agent writes there: it must not redirect a read or a write to a file of the Mac.
 */
async function widgetFolderOn(paths: SpacePaths, id: string): Promise<string | null> {
  return confinedFolder(paths.widgets, id);
}

/** An action's folder, with the same guards as a widget's. */
export async function actionFolder(paths: SpacePaths, id: string): Promise<string | null> {
  return confinedFolder(paths.actions, id);
}

async function confinedFolder(parent: string, id: string): Promise<string | null> {
  try {
    if ((await lstat(parent)).isSymbolicLink()) return null;
    const folder = join(parent, id);
    const l = await lstat(folder);
    if (l.isSymbolicLink() || !l.isDirectory()) return null;
    const [root, real] = await Promise.all([realpath(parent), realpath(folder)]);
    return real.startsWith(root + sep) ? folder : null;
  } catch {
    return null;
  }
}

/** The checked file, read without following a link nor blocking on a pipe; null if it is not a regular file. */
async function readFileOnly(path: string): Promise<string | null> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    return (await f.stat()).isFile() ? await f.readFile("utf8") : null;
  } finally {
    await f.close();
  }
}

type Declaration = { declaration: DeclarationWidget; folder: string } | { absent: true } | { invalid: string };

/** One widget's `widget.json` only, without following a link out of its folder. */
async function readDeclaration(paths: SpacePaths, id: string): Promise<Declaration> {
  const folder = await widgetFolderOn(paths, id);
  if (!folder) return { absent: true };
  try {
    const [root, real] = await Promise.all([realpath(folder), realpath(join(folder, "widget.json"))]);
    if (!real.startsWith(root + sep)) return { invalid: "widget.json sort du dossier du widget" };
    const text = await readFileOnly(real);
    if (text === null) return { invalid: "widget.json n'est pas un fichier" };
    return { declaration: DeclarationWidget.parse(JSON.parse(text)), folder: folder };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { absent: true };
    return { invalid: (e as Error).message };
  }
}

function warningsOf(raw: unknown, d: DeclarationWidget): Warning[] {
  const r = validateWorkflow(raw, validationContext(d));
  return r.ok ? warnWorkflow(r.valid.workflow, { sources: d.sources, config: d.config, maxDurationMinutes: d.harvest?.maxDurationMinutes ?? null }, r.valid) : [];
}

/** What the builder opens for a widget; null: unknown widget (or unreadable widget.json), no harvest, or disk error. Writes nothing. */
export async function readEdit(c: Context, id: string): Promise<WorkflowEdit | null> {
  try {
    const d = await readDeclaration(c.paths, id);
    if (!("declaration" in d)) return null;
    const l = await readDraft(d.folder, validationContext(d.declaration));
    if (!l) return null;
    const decl = d.declaration;
    const r = decl.harvest;
    return {
      ...l,
      warnings: l.raw === null ? [] : warningsOf(l.raw, decl),
      widget: {
        name: decl.name,
        account: decl.sources.account,
        public: decl.sources.public,
        config: decl.config ?? null,
        web: decl.sources.web,
        harvest: r
          ? { minutes: r.minutes ?? null, hours: r.hours ?? [], maxDurationMinutes: r.maxDurationMinutes ?? null, notify: r.notify === true }
          : null,
      },
    };
  } catch (e) {
    console.error(`[ressac] reading the workflow of widget ${id}:`, e);
    return null;
  }
}

/** Saves the widget's draft; the warnings are those of the validated workflow (none if invalid). Call inside `inSeries`. */
export async function saveEdit(c: Context, id: string, raw: unknown): Promise<SaveResult & { warnings: Warning[] }> {
  try {
    const d = await readDeclaration(c.paths, id);
    if ("invalid" in d) return { ok: false, error: `widget.json invalide : ${d.invalid}`, warnings: [] };
    if (!("declaration" in d)) return { ok: false, error: "Widget introuvable", warnings: [] };
    const r = await saveWorkflow({
      filesFolder: d.folder,
      dataFolder: join(c.widgetsFolder, id),
      raw: raw,
      context: validationContext(d.declaration),
    });
    return { ...r, warnings: r.ok ? warningsOf(raw, d.declaration) : [] };
  } catch (e) {
    console.error(`[ressac] saving the workflow of widget ${id}:`, e);
    return { ok: false, error: UNREADABLE_MESSAGE, warnings: [] };
  }
}

export async function readCode(paths: SpacePaths, id: string, name: string): Promise<{ text: string } | { absent: true } | { error: string }> {
  const folder = await widgetFolderOn(paths, id);
  if (!folder) return { error: "Widget introuvable" };
  return readCodeFile(folder, name);
}

/** Call inside `inSeries`: the folder is checked again just before writing. */
export async function saveCode(paths: SpacePaths, id: string, name: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const folder = await widgetFolderOn(paths, id);
  if (!folder) return { ok: false, error: "Widget introuvable" };
  try {
    return await storeCode(folder, name, text);
  } catch (e) {
    console.error(`[ressac] code of widget ${id}:`, e);
    return { ok: false, error: UNREADABLE_MESSAGE };
  }
}

// --- An action's workflow (`ressac://workflow/action/<id>`).

type ActionContext = { paths: SpacePaths; actionsFolder: string };

/** `action.json` read, and the action's (confined) folder; null: unknown action; `error`: unreadable declaration. */
async function declarationAction(paths: SpacePaths, id: string): Promise<{ declaration: DeclarationAction; folder: string } | { error: string } | null> {
  const folder = await actionFolder(paths, id);
  const a = folder ? await readAction(paths, id) : null;
  if (!folder || !a) return null;
  return "error" in a ? { error: a.error } : { declaration: a.declaration, folder: folder };
}

function actionWarnings(raw: unknown, d: DeclarationAction): Warning[] {
  const r = validateWorkflow(raw, actionValidationContext(d));
  if (!r.ok) return [];
  return warnWorkflow(
    r.valid.workflow,
    { sources: d.sources, config: null, maxDurationMinutes: d.maxDurationMinutes ?? null, owner: "action", input: d.input !== undefined },
    r.valid,
  );
}

/** What the builder opens for an action: its `workflow.json` only (no implicit workflow); null: unknown, unreadable, no workflow or disk error. Writes nothing. */
export async function readActionEdit(c: ActionContext, id: string): Promise<WorkflowEdit | null> {
  try {
    const d = await declarationAction(c.paths, id);
    if (!d || "error" in d) return null;
    const decl = d.declaration;
    const l = await readDraft(d.folder, actionValidationContext(decl));
    if (!l || l.origin !== "file") return null;
    return {
      ...l,
      warnings: l.raw === null ? [] : actionWarnings(l.raw, decl),
      action: {
        name: decl.name,
        account: decl.sources.account,
        public: decl.sources.public,
        web: decl.sources.web,
        input: decl.input ?? null,
        layout: decl.layout ?? null,
        maxDurationMinutes: decl.maxDurationMinutes ?? null,
      },
    };
  } catch (e) {
    console.error(`[ressac] reading the workflow of action ${id}:`, e);
    return null;
  }
}

/** Saves the action's draft; `action.json` is never written. Call inside `inSeries`. */
export async function saveActionEdit(c: ActionContext, id: string, raw: unknown): Promise<SaveResult & { warnings: Warning[] }> {
  try {
    const d = await declarationAction(c.paths, id);
    if (!d) return { ok: false, error: ACTION_UNKNOWN, warnings: [] };
    if ("error" in d) return { ok: false, error: d.error, warnings: [] };
    const r = await saveWorkflow({
      filesFolder: d.folder,
      dataFolder: join(c.actionsFolder, id),
      raw: raw,
      context: actionValidationContext(d.declaration),
    });
    return { ...r, warnings: r.ok ? actionWarnings(raw, d.declaration) : [] };
  } catch (e) {
    console.error(`[ressac] saving the workflow of action ${id}:`, e);
    return { ok: false, error: UNREADABLE_MESSAGE, warnings: [] };
  }
}

export async function readActionCode(paths: SpacePaths, id: string, name: string): Promise<{ text: string } | { absent: true } | { error: string }> {
  const folder = await actionFolder(paths, id);
  if (!folder) return { error: ACTION_UNKNOWN };
  return readCodeFile(folder, name);
}

/** Call inside `inSeries`: the folder is checked again just before writing. */
export async function saveActionCode(paths: SpacePaths, id: string, name: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const folder = await actionFolder(paths, id);
  if (!folder) return { ok: false, error: ACTION_UNKNOWN };
  try {
    return await storeCode(folder, name, text);
  } catch (e) {
    console.error(`[ressac] code of action ${id}:`, e);
    return { ok: false, error: UNREADABLE_MESSAGE };
  }
}
