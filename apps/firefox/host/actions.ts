import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACTION_UNKNOWN,
  chainsOf,
  ID_ACTION,
  ID_EXECUTION,
  readGrants,
  readAction,
  readActions,
  readRun,
  readResult,
  listRuns,
  removeGrant,
  deleteDataAction,
  type ReadAction,
  type SpacePaths,
  type ActionsState,
  type Execution,
  type Kernel,
  type PageAction,
  type LaunchResult,
  type ResumeExecution,
} from "../../../packages/kernel/src/index.ts";
import type { ActionShown } from "../shared/actions.ts";
import type { Grant } from "../shared/api.ts";
import { openableUrl } from "../ui/home-profiles.ts";
import { hostLocale, hostSay } from "./locale.ts";

// The disk and kernel half of the actions service.

export const NO_KERNEL_MESSAGE = () => hostSay("host-actions-no-kernel");
const NO_ACTION: ActionsState = { running: [], waiting: [] };

/** https only, never the machine. Keep in sync with chrome/store/action-media.ts. */
const imageAddressAllowed = (url: string) => url.startsWith("https://") && openableUrl(url);

/**
 * The refusal half of a result image's load: a result image is fetched only for a current action
 * without account, a kept run, and an https address present as is in its results, with no grant for the account.
 */
export async function actionImageAllowed(
  o: { actionsFolder: string; readAction: (id: string) => Promise<ReadAction | null> },
  id: string,
  execution: string,
  url: string,
): Promise<boolean> {
  if (!ID_ACTION.test(id) || execution.length > 64 || !ID_EXECUTION.test(execution) || !url || !imageAddressAllowed(url)) return false;
  const action = await o.readAction(id);
  if (!action || "error" in action || action.declaration.sources.account.length > 0) return false;
  // An action rewritten without account may keep results read with it: a grant still there is enough to refuse.
  const grants = await readGrants(o.actionsFolder).catch(() => null);
  if (!grants || Object.hasOwn(grants, id)) return false;
  const [result, exec] = await Promise.all([readResult(o.actionsFolder, id, execution), readRun(join(o.actionsFolder, id), execution)]);
  return !!result && !!exec && chainsOf(result.results).has(url);
}

/** A link of an action's page opens only if its address is, as is, in the run's results, in http(s). */
export async function linkAllowed(actionsFolder: string, id: string, execution: string, url: string): Promise<boolean> {
  if (!openableUrl(url)) return false;
  const r = await readResult(actionsFolder, id, execution);
  return !!r && chainsOf(r.results).has(url);
}

/** The action's folder goes to actions/.trash (nothing is destroyed), then `forget` drops its grant and data. */
export async function trashAction(c: SpacePaths, id: string, forget: (id: string) => Promise<void>): Promise<void> {
  if (!ID_ACTION.test(id)) throw new Error(`id d'action invalide : ${id}`);
  const trash = join(c.actions, ".trash");
  await mkdir(trash, { recursive: true });
  await rename(join(c.actions, id), join(trash, `${id}-${Date.now()}`));
  await forget(id);
}

/** The disk's actions, ready to show: declaration, grant and last real run. Read without the kernel. */
export async function readShownActions(c: SpacePaths, actionsFolder: string): Promise<ActionShown[]> {
  const [alreadyRead, grants] = await Promise.all([readActions(c), readGrants(actionsFolder).catch(() => ({}) as Record<string, unknown>)]);
  return Promise.all(
    alreadyRead.map(async (a): Promise<ActionShown> => {
      const last = (await listRuns(join(actionsFolder, a.id))).find((e) => !e.attempt && !e.id.endsWith("-attempt"));
      const lastRun = last ? { run: last.id, start: last.start, status: last.status } : null;
      if ("error" in a) return { id: a.id, name: a.id, description: "", keywords: [], input: null, account: [], public: [], grant: false, last: lastRun, error: a.error };
      const d = a.declaration;
      return {
        id: a.id,
        name: d.name,
        description: d.description,
        keywords: d.keywords,
        input: d.input ?? null,
        account: d.sources.account,
        public: d.sources.public,
        grant: Object.hasOwn(grants, a.id),
        last: lastRun,
      };
    }),
  );
}

type Prepared = { ok: true; name: string; launch: boolean } | { ok: false; error: string };

/** The actions service without the window state (private spaces, tabs, links' pace: the chrome's) and `agir`. */
export function createActionsHost(o: {
  paths: SpacePaths;
  actionsFolder: string;
  kernel: () => Kernel | null;
  /** A launch refused without a run written was just noted: the actions pages read again. */
  onChange: () => void;
  now?: () => number;
}) {
  const now = o.now ?? Date.now;
  /** Per action, the last launch refused without writing anything: the page cannot read it on disk, `liste` gives it. */
  const launchDenial = new Map<string, { error: string; when: string }>();
  // Kept on disk next to the runs: a refusal survives a restart.
  const denialFile = join(o.actionsFolder, "launch-denials.json");
  const onLoaded = readFile(denialFile, "utf8").then(
    (t) => {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed !== "object" || parsed === null) return;
      for (const [id, v] of Object.entries(parsed)) {
        const { error: error, when: when } = (v ?? {}) as { error?: unknown; when?: unknown };
        if (typeof error === "string" && typeof when === "string") launchDenial.set(id, { error: error, when: when });
      }
    },
    () => {},
  );
  let writing = Promise.resolve();
  const recordDenial = () => {
    const t = JSON.stringify(Object.fromEntries(launchDenial));
    writing = writing
      .then(() => mkdir(o.actionsFolder, { recursive: true }))
      .then(() => writeFile(denialFile, t))
      .catch((e) => console.error("[ressac] action refusals not saved:", e));
  };
  /** Followed launches, per action: a deletion forgets them, their end notes nothing (action made again under the same id). */
  const trackedLaunches = new Map<string, Set<Promise<LaunchResult>>>();
  const followLaunch = (id: string, end: Promise<LaunchResult>): Promise<LaunchResult> => {
    const ready = onLoaded.then(() => launchDenial.delete(id) && recordDenial());
    const tracked = trackedLaunches.get(id) ?? new Set();
    trackedLaunches.set(id, tracked.add(end));
    return end.then(async (r) => {
      await ready;
      const tracking = trackedLaunches.get(id)?.delete(end) ?? false;
      if (trackedLaunches.get(id)?.size === 0) trackedLaunches.delete(id);
      if (tracking && !r.run) {
        launchDenial.set(id, { error: r.error ?? hostSay("host-action-launch-failed"), when: new Date(now()).toISOString() });
        recordDenial();
        o.onChange();
      }
      return r;
    });
  };
  const read = (id: string) => readAction(o.paths, id);
  const nameOf = (a: ReadAction) => ("error" in a ? a.id : a.declaration.name);
  let currentActions = new Set<string>();
  return {
    async list(): Promise<ActionShown[]> {
      await onLoaded;
      return (await readShownActions(o.paths, o.actionsFolder)).map((a) => {
        const r = launchDenial.get(a.id);
        return r && (!a.last || a.last.start < r.when) ? { ...a, denial: r.error } : a;
      });
    },
    /** Reads the action without launching it: `launch` says whether the chrome should launch it after opening its page. */
    async prepare(id: string, input: string | null): Promise<Prepared> {
      const kernel = o.kernel();
      if (!kernel) return { ok: false, error: NO_KERNEL_MESSAGE() };
      const a = await read(id);
      if (!a) return { ok: false, error: ACTION_UNKNOWN(hostLocale()) };
      const d = kernel.actions.direct();
      const running = d.running.some((x) => x.action === id) || d.waiting.some((x) => x.action === id);
      // Required input missing: the page opens with its field to fill, nothing is launched.
      const inputMissing = !("error" in a) && !!a.declaration.input && !input?.trim();
      return { ok: true, name: nameOf(a), launch: !running && !inputMissing };
    },
    /** The action's name for « Voir le workflow », read without the kernel. */
    async name(id: string): Promise<string | null> {
      const a = await read(id);
      return a ? nameOf(a).slice(0, 60) : null;
    },
    async launch(id: string, input: string | null): Promise<LaunchResult> {
      const kernel = o.kernel();
      if (!kernel) return { status: "invalid", error: NO_KERNEL_MESSAGE() };
      return followLaunch(id, kernel.actions.launch(id, { ...(input?.trim() ? { input: input } : {}), trigger: "manual" }).end);
    },
    stop(id: string): void {
      o.kernel()?.actions.stop(id);
    },
    async page(id: string, execution: string | null): Promise<PageAction | null> {
      const kernel = o.kernel();
      // Refused, not null (« no result »): a page read before the kernel started reads again on its first `access`.
      if (!kernel) throw new Error(NO_KERNEL_MESSAGE());
      return (await kernel.actions.page(id, execution)) ?? null;
    },
    async runs(id: string): Promise<ResumeExecution[]> {
      const kernel = o.kernel();
      if (kernel) return kernel.actions.runs(id);
      return ID_ACTION.test(id) ? listRuns(join(o.actionsFolder, id)) : [];
    },
    async run(id: string, execution: string): Promise<Execution | null> {
      if (!ID_ACTION.test(id) || !ID_EXECUTION.test(execution)) return null;
      const kernel = o.kernel();
      return kernel ? kernel.actions.run(id, execution) : readRun(join(o.actionsFolder, id), execution);
    },
    async direct(): Promise<ActionsState> {
      return o.kernel()?.actions.direct() ?? NO_ACTION;
    },
    linkAllowed: (id: string, execution: string, url: string) => linkAllowed(o.actionsFolder, id, execution, url),
    imageAllowed: (id: string, execution: string, url: string) => actionImageAllowed({ actionsFolder: o.actionsFolder, readAction: read }, id, execution, url),
    async grant(a: Grant): Promise<{ ok: true } | { ok: false; error: string }> {
      const kernel = o.kernel();
      if (!kernel) return { ok: false, error: NO_KERNEL_MESSAGE() };
      try {
        // The kernel refuses if the declaration is no longer the one the card showed.
        await kernel.actions.grant(a);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    async denyGrant(id: string): Promise<void> {
      const kernel = o.kernel();
      // A run in progress would keep its place in the queue and its priority on the AI until its end.
      kernel?.actions.stop(id);
      await kernel?.actions.denyGrant(id);
    },
    async delete(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
      if (!(await read(id))) return { ok: false, error: ACTION_UNKNOWN(hostLocale()) };
      // Stopped first: otherwise it would run to its maximum duration with nothing left to stop it.
      o.kernel()?.actions.stop(id);
      // Removed from disk too: an action made again under the same id would find this refusal at the next start.
      await onLoaded;
      if (launchDenial.delete(id)) recordDenial();
      trackedLaunches.delete(id);
      const forget = async (x: string) => {
        const kernel = o.kernel();
        if (kernel) return kernel.actions.denyGrant(x);
        await removeGrant(o.actionsFolder, x);
        await deleteDataAction(o.actionsFolder, x);
      };
      try {
        await trashAction(o.paths, id, forget);
        return { ok: true };
      } catch (e) {
        console.error(`[ressac] action ${id} not deleted:`, e);
        return { ok: false, error: hostSay("host-action-delete-failed") };
      }
    },
    /** A finished action has a new last result (written outside the watched space): the list reads again. */
    directSeen(e: ActionsState): void {
      const currentOnes = new Set(e.running.map((c) => c.action));
      const quit = [...currentActions].some((a) => !currentOnes.has(a));
      currentActions = currentOnes;
      if (quit) o.onChange();
    },
  };
}
