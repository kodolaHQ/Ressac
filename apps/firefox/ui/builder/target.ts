import type { DirectWidget, ActionsState, DirectState, Owner } from "@webaios/kernel";
import type { ApiWebaios } from "../../shared/api";
import type { Depot } from "./edit.svelte";
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
export function repoOf(w: Pick<ApiWebaios["workflow"], "read" | "save" | "readCode" | "saveCode">): Depot {
  return {
    read: (key) => w.read(targetOfKey(key)),
    save: (key, b) => w.save(targetOfKey(key), b),
    readCode: (key, name) => w.readCode(targetOfKey(key), name),
    saveCode: (key, name, text) => w.saveCode(targetOfKey(key), name, text),
  };
}

/** The runs of a widget (stored with home) or of an action. */
export function runsSourceOf(api: Pick<ApiWebaios, "home" | "actions">, target: Owner): SourceExecutions {
  if (target.type === "widget") return api.home;
  return { runs: () => api.actions.runs(target.id), run: (_key, e) => api.actions.run(target.id, e) };
}

/** What is running, seen as for widgets: a current action becomes a run (or a trial) of its key. */
export function actionsDirect(e: ActionsState): DirectState {
  return {
    running: e.running.map(
      (c): DirectWidget => ({
        widget: ACTION_PREFIX + c.action,
        kind: c.attempt ? "essai" : "execution",
        start: c.start,
        blocks: Object.fromEntries(Object.entries(c.blocks).map(([id, b]) => [id, { status: b.status, items: b.items }])),
      }),
    ),
    waiting: e.waiting.map((a) => ACTION_PREFIX + a.action),
  };
}

/** « ▶ Lancer », « Rejouer » and live tracking: the widgets', or the actions'. */
export function launcherOf(api: Pick<ApiWebaios, "workflow" | "actions">, target: Owner): Launcher {
  const w = api.workflow;
  const common = {
    launch: (key: string, input?: string | null) => w.launch(targetOfKey(key), input),
    replay: (key: string, execution: string, block: string) => w.replay(targetOfKey(key), execution, block),
  };
  if (target.type === "widget") return { ...common, direct: () => w.direct(), onLive: (r) => w.onLive(r) };
  return { ...common, direct: () => api.actions.direct().then(actionsDirect), onLive: (r) => api.actions.onLive((e) => r(actionsDirect(e))) };
}
