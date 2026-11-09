import type { DirectWidget, ActionsState, DirectState, Owner } from "@webaios/kernel";
import type { ApiWebaios } from "../../shared/api";
import type { Depot } from "./edition.svelte";
import type { Launcher, SourceExecutions } from "./executions.svelte";

const ACTION_PREFIX = "action:";

/**
 * A workflow's key in the window states (edits, unsaved codes, chosen run): a widget's id as is, `action:<id>` for
 * an action (a widget and an action with the same name do not get mixed up).
 */
export const targetKey = (c: Owner): string => (c.type === "widget" ? c.id : ACTION_PREFIX + c.id);
export const targetOfKey = (key: string): Owner =>
  key.startsWith(ACTION_PREFIX) ? { type: "action", id: key.slice(ACTION_PREFIX.length) } : { type: "widget", id: key };
export const isActionKey = (key: string): boolean => key.startsWith(ACTION_PREFIX);

/** Reading and writing the workflow and its codes, addressed by key. */
export function depotDe(w: Pick<ApiWebaios["workflow"], "lire" | "enregistrer" | "lireCode" | "enregistrerCode">): Depot {
  return {
    lire: (key) => w.lire(targetOfKey(key)),
    enregistrer: (key, b) => w.enregistrer(targetOfKey(key), b),
    lireCode: (key, name) => w.lireCode(targetOfKey(key), name),
    enregistrerCode: (key, name, text) => w.enregistrerCode(targetOfKey(key), name, text),
  };
}

/** The runs of a widget (stored with home) or of an action. */
export function sourceExecutionsDe(api: Pick<ApiWebaios, "accueil" | "actions">, target: Owner): SourceExecutions {
  if (target.type === "widget") return api.accueil;
  return { executions: () => api.actions.executions(target.id), execution: (_key, e) => api.actions.execution(target.id, e) };
}

/** What is running, seen as for widgets: a current action becomes a run (or a trial) of its key. */
export function directDesActions(e: ActionsState): DirectState {
  return {
    courants: e.courantes.map(
      (c): DirectWidget => ({
        widget: ACTION_PREFIX + c.action,
        genre: c.essai ? "essai" : "execution",
        debut: c.debut,
        blocs: Object.fromEntries(Object.entries(c.blocs).map(([id, b]) => [id, { statut: b.statut, elements: b.elements }])),
      }),
    ),
    enAttente: e.enAttente.map((a) => ACTION_PREFIX + a.action),
  };
}

/** « ▶ Lancer », « Rejouer » and live tracking: the widgets', or the actions'. */
export function launcherOf(api: Pick<ApiWebaios, "workflow" | "actions">, target: Owner): Launcher {
  const w = api.workflow;
  const common = {
    lancer: (key: string, input?: string | null) => w.lancer(targetOfKey(key), input),
    rejouer: (key: string, execution: string, bloc: string) => w.rejouer(targetOfKey(key), execution, bloc),
  };
  if (target.type === "widget") return { ...common, direct: () => w.direct(), surDirect: (r) => w.surDirect(r) };
  return { ...common, direct: () => api.actions.direct().then(directDesActions), surDirect: (r) => api.actions.surDirect((e) => r(directDesActions(e))) };
}
