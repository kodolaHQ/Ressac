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
  lireAction,
  readDraft,
  lireCode,
  validateWorkflow,
  type Warning,
  type DeclarationAction,
  type SpacePaths,
  type SaveResult,
  type OpenWorkflow,
} from "../../../packages/kernel/src/index.ts";
import { workflowUrlTarget } from "../shared/model.ts";
import type { EditionWorkflow, BuilderSelection } from "../shared/api.ts";

// The widget and action parts of the workflow builder.

/**
 * What the agent may know of a window's builder: only whether its active tab is `webaios://workflow/<widget>` or
 * `webaios://workflow/action/<action>`; the block only if the selection is on that very workflow.
 */
export function workflowOpen(activeUrl: string | undefined, selection: BuilderSelection | undefined): OpenWorkflow | null {
  const target = activeUrl ? workflowUrlTarget(activeUrl) : null;
  if (!target) return null;
  const s = selection;
  if (target.type === "widget") return { widget: target.id, bloc: s && "widget" in s && s.widget === target.id ? s.bloc : null };
  return { action: target.id, bloc: s && "action" in s && s.action === target.id ? s.bloc : null };
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

type Context = { chemins: SpacePaths; dossierWidgets: string };

const UNREADABLE_MESSAGE = "Écriture impossible";

/**
 * The widget's folder, or null: the widgets folder must not be a link, the widget folder must be a real folder (not a
 * link) inside it. The agent writes there: it must not redirect a read or a write to a file of the Mac.
 */
async function dossierWidgetSur(paths: SpacePaths, id: string): Promise<string | null> {
  return dossierConfine(paths.widgets, id);
}

/** An action's folder, with the same guards as a widget's. */
export async function actionFolder(paths: SpacePaths, id: string): Promise<string | null> {
  return dossierConfine(paths.actions, id);
}

async function dossierConfine(parent: string, id: string): Promise<string | null> {
  try {
    if ((await lstat(parent)).isSymbolicLink()) return null;
    const dossier = join(parent, id);
    const l = await lstat(dossier);
    if (l.isSymbolicLink() || !l.isDirectory()) return null;
    const [root, reel] = await Promise.all([realpath(parent), realpath(dossier)]);
    return reel.startsWith(root + sep) ? dossier : null;
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

type Declaration = { declaration: DeclarationWidget; dossier: string } | { absent: true } | { invalide: string };

/** One widget's `widget.json` only, without following a link out of its folder. */
async function lireDeclaration(paths: SpacePaths, id: string): Promise<Declaration> {
  const dossier = await dossierWidgetSur(paths, id);
  if (!dossier) return { absent: true };
  try {
    const [root, reel] = await Promise.all([realpath(dossier), realpath(join(dossier, "widget.json"))]);
    if (!reel.startsWith(root + sep)) return { invalide: "widget.json sort du dossier du widget" };
    const text = await readFileOnly(reel);
    if (text === null) return { invalide: "widget.json n'est pas un fichier" };
    return { declaration: DeclarationWidget.parse(JSON.parse(text)), dossier };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { absent: true };
    return { invalide: (e as Error).message };
  }
}

function warningsOf(brut: unknown, d: DeclarationWidget): Warning[] {
  const r = validateWorkflow(brut, validationContext(d));
  return r.ok ? warnWorkflow(r.valide.workflow, { sources: d.sources, config: d.config, dureeMaxMinutes: d.recolte?.dureeMaxMinutes ?? null }, r.valide) : [];
}

/** What the builder opens for a widget; null: unknown widget (or unreadable widget.json), no harvest, or disk error. Writes nothing. */
export async function readEdition(c: Context, id: string): Promise<EditionWorkflow | null> {
  try {
    const d = await lireDeclaration(c.chemins, id);
    if (!("declaration" in d)) return null;
    const l = await readDraft(d.dossier, validationContext(d.declaration));
    if (!l) return null;
    const decl = d.declaration;
    const r = decl.recolte;
    return {
      ...l,
      avertissements: l.brut === null ? [] : warningsOf(l.brut, decl),
      widget: {
        nom: decl.nom,
        compte: decl.sources.compte,
        publiques: decl.sources.publiques,
        config: decl.config ?? null,
        web: decl.sources.web,
        recolte: r
          ? { minutes: r.minutes ?? null, heures: r.heures ?? [], dureeMaxMinutes: r.dureeMaxMinutes ?? null, notifier: r.notifier === true }
          : null,
      },
    };
  } catch (e) {
    console.error(`[webaios] lecture du workflow du widget ${id} :`, e);
    return null;
  }
}

/** Saves the widget's draft; the warnings are those of the validated workflow (none if invalid). Call inside `inSeries`. */
export async function saveEdition(c: Context, id: string, brut: unknown): Promise<SaveResult & { avertissements: Warning[] }> {
  try {
    const d = await lireDeclaration(c.chemins, id);
    if ("invalide" in d) return { ok: false, erreur: `widget.json invalide : ${d.invalide}`, avertissements: [] };
    if (!("declaration" in d)) return { ok: false, erreur: "Widget introuvable", avertissements: [] };
    const r = await saveWorkflow({
      dossierFichiers: d.dossier,
      dossierDonnees: join(c.dossierWidgets, id),
      brut,
      contexte: validationContext(d.declaration),
    });
    return { ...r, avertissements: r.ok ? warningsOf(brut, d.declaration) : [] };
  } catch (e) {
    console.error(`[webaios] enregistrement du workflow du widget ${id} :`, e);
    return { ok: false, erreur: UNREADABLE_MESSAGE, avertissements: [] };
  }
}

export async function readCode(paths: SpacePaths, id: string, name: string): Promise<{ texte: string } | { absent: true } | { erreur: string }> {
  const dossier = await dossierWidgetSur(paths, id);
  if (!dossier) return { erreur: "Widget introuvable" };
  return lireCode(dossier, name);
}

/** Call inside `inSeries`: the folder is checked again just before writing. */
export async function saveCode(paths: SpacePaths, id: string, name: string, text: string): Promise<{ ok: true } | { ok: false; erreur: string }> {
  const dossier = await dossierWidgetSur(paths, id);
  if (!dossier) return { ok: false, erreur: "Widget introuvable" };
  try {
    return await storeCode(dossier, name, text);
  } catch (e) {
    console.error(`[webaios] code du widget ${id} :`, e);
    return { ok: false, erreur: UNREADABLE_MESSAGE };
  }
}

// --- An action's workflow (`webaios://workflow/action/<id>`).

type ActionContext = { chemins: SpacePaths; dossierActions: string };

/** `action.json` read, and the action's (confined) folder; null: unknown action; `erreur`: unreadable declaration. */
async function declarationAction(paths: SpacePaths, id: string): Promise<{ declaration: DeclarationAction; dossier: string } | { erreur: string } | null> {
  const dossier = await actionFolder(paths, id);
  const a = dossier ? await lireAction(paths, id) : null;
  if (!dossier || !a) return null;
  return "erreur" in a ? { erreur: a.erreur } : { declaration: a.declaration, dossier };
}

function actionWarnings(brut: unknown, d: DeclarationAction): Warning[] {
  const r = validateWorkflow(brut, actionValidationContext(d));
  if (!r.ok) return [];
  return warnWorkflow(
    r.valide.workflow,
    { sources: d.sources, config: null, dureeMaxMinutes: d.dureeMaxMinutes ?? null, proprietaire: "action", saisie: d.saisie !== undefined },
    r.valide,
  );
}

/** What the builder opens for an action: its `workflow.json` only (no implicit workflow); null: unknown, unreadable, no workflow or disk error. Writes nothing. */
export async function readActionEdition(c: ActionContext, id: string): Promise<EditionWorkflow | null> {
  try {
    const d = await declarationAction(c.chemins, id);
    if (!d || "erreur" in d) return null;
    const decl = d.declaration;
    const l = await readDraft(d.dossier, actionValidationContext(decl));
    if (!l || l.origine !== "fichier") return null;
    return {
      ...l,
      avertissements: l.brut === null ? [] : actionWarnings(l.brut, decl),
      action: {
        nom: decl.nom,
        compte: decl.sources.compte,
        publiques: decl.sources.publiques,
        web: decl.sources.web,
        saisie: decl.saisie ?? null,
        miseEnPage: decl.miseEnPage ?? null,
        dureeMaxMinutes: decl.dureeMaxMinutes ?? null,
      },
    };
  } catch (e) {
    console.error(`[webaios] lecture du workflow de l'action ${id} :`, e);
    return null;
  }
}

/** Saves the action's draft; `action.json` is never written. Call inside `inSeries`. */
export async function saveActionEdition(c: ActionContext, id: string, brut: unknown): Promise<SaveResult & { avertissements: Warning[] }> {
  try {
    const d = await declarationAction(c.chemins, id);
    if (!d) return { ok: false, erreur: ACTION_UNKNOWN, avertissements: [] };
    if ("erreur" in d) return { ok: false, erreur: d.erreur, avertissements: [] };
    const r = await saveWorkflow({
      dossierFichiers: d.dossier,
      dossierDonnees: join(c.dossierActions, id),
      brut,
      contexte: actionValidationContext(d.declaration),
    });
    return { ...r, avertissements: r.ok ? actionWarnings(brut, d.declaration) : [] };
  } catch (e) {
    console.error(`[webaios] enregistrement du workflow de l'action ${id} :`, e);
    return { ok: false, erreur: UNREADABLE_MESSAGE, avertissements: [] };
  }
}

export async function readActionCode(paths: SpacePaths, id: string, name: string): Promise<{ texte: string } | { absent: true } | { erreur: string }> {
  const dossier = await actionFolder(paths, id);
  if (!dossier) return { erreur: ACTION_UNKNOWN };
  return lireCode(dossier, name);
}

/** Call inside `inSeries`: the folder is checked again just before writing. */
export async function saveActionCode(paths: SpacePaths, id: string, name: string, text: string): Promise<{ ok: true } | { ok: false; erreur: string }> {
  const dossier = await actionFolder(paths, id);
  if (!dossier) return { ok: false, erreur: ACTION_UNKNOWN };
  try {
    return await storeCode(dossier, name, text);
  } catch (e) {
    console.error(`[webaios] code de l'action ${id} :`, e);
    return { ok: false, erreur: UNREADABLE_MESSAGE };
  }
}
