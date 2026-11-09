import { ACTIONS_IN_PRIVATE_SPACE } from "../shared/actions";
import type { Action, ApiWebaios } from "../shared/api";
import type { BrowserState, WindowId } from "../shared/model";
import { HOST_EXITED, type AgentHost } from "../chrome/agent/host";
import type { WebAiOsStore } from "../chrome/store";
import { readableProfiles, profilesForGrant } from "./home-profiles";

// The window half of the actions service: private spaces, dispatches, the pace of
// links, the direct feed's filter and the grant profiles. The disk and kernel half is the host's (host/actions.ts).

/** A missing window or space counts as private. */
export function activeSpacePrivate(appState: Pick<BrowserState, "spaces" | "windows">, f: WindowId): boolean {
  const win = appState.windows.find((x) => x.id === f);
  return !win || (appState.spaces.find((e) => e.id === win.activeSpace)?.private ?? true);
}

/** The actions API, plus what the Firefox page asks the chrome for: result images and agent components. */
export type ActionsFirefox = ApiWebaios["actions"] & {
  image(id: string, execution: string, url: string): Promise<string | null>;
  serveComponent(name: string): Promise<string | null>;
  releaseComponent(name: string): void;
};

// Shown when the actions service has no kernel (same texts as host/actions.ts).
const NO_KERNEL_MESSAGE = "Le service des actions ne répond pas (agent arrêté ?)";
const NO_ACTION = () => ({ running: [], waiting: [] });

export function createActionsApi(o: {
  state: () => BrowserState | undefined;
  dispatch: (a: Action) => void;
  host: AgentHost;
  window: WindowId;
  untilUnload: (unsubscribe: () => void) => () => void;
  media: WebAiOsStore["actionMedia"];
}): ActionsFirefox {
  const { host, window: win } = o;
  /** Read at each call and again after each wait: the window may have moved to a private space meanwhile. */
  const isPrivate = () => {
    const s = o.state();
    return !s || activeSpacePrivate(s, win);
  };
  const denial = { ok: false as const, error: ACTIONS_IN_PRIVATE_SPACE };
  /** The host stopped or did not answer a request: the next `acces` reads again (afterRestart). */
  let hostDown = false;
  /** The `acces` handled so far: a refusal answered before one of them but handled after it still reads again. */
  let accessSeen = 0;
  /** The last answer to each read of the page: a host that stopped answers nothing, and the page keeps what it showed. */
  const lastRead = new Map<string, unknown>();
  /**
   * A host request answered in this realm, `empty` in a private space (before and after). When the host does not
   * answer: with `keep`, the last answer to the same request, otherwise `empty`.
   */
  const ask = async <T>(method: string, params: unknown, empty: () => T, keep = false): Promise<T> => {
    if (isPrivate()) return empty();
    const key = JSON.stringify([method, params]);
    const seen = accessSeen;
    const r = await host.request<T>(method, params).then(
      (v) => {
        if (keep) lastRead.set(key, v);
        return structuredClone(v);
      },
      () => {
        // An acces handled meanwhile may be the kernel's first, read with this refusal in one go: read again now.
        if (accessSeen !== seen) readAgain();
        else hostDown = true;
        return keep && lastRead.has(key) ? structuredClone(lastRead.get(key) as T) : empty();
      },
    );
    return isPrivate() ? empty() : r;
  };
  /**
   * The host stopped, or did not answer this API (a page opened while it was down): the first `acces`, sent once its
   * kernel runs again, calls the subscribers back once. Meanwhile pages keep their last read; later `acces` (each policy
   * change) are ignored.
   */
  const restarted = new Set<() => void>();
  const readAgain = () => restarted.forEach((cb) => cb());
  o.untilUnload(host.on(HOST_EXITED, () => (hostDown = true)));
  o.untilUnload(
    host.on("acces", () => {
      accessSeen++;
      if (!hostDown) return;
      hostDown = false;
      readAgain();
    }),
  );
  /** An action's grant or folder is gone: none of its cached reads, nor the cached list, may come back. */
  const forget = (id: string) => {
    for (const key of lastRead.keys()) {
      const [method, params] = JSON.parse(key) as [string, { id?: string } | undefined];
      if (method === "actions.liste" || params?.id === id) lastRead.delete(key);
    }
  };
  /** The store references this document holds on each component; the serves answered null in a private space. */
  const served = new Map<string, number>();
  const unserved = new Map<string, number>();
  const bump = (m: Map<string, number>, name: string, d: number) => {
    const n = (m.get(name) ?? 0) + d;
    if (n > 0) m.set(name, n);
    else m.delete(name);
  };
  const afterRestart = (cb: () => void) => (restarted.add(cb), () => void restarted.delete(cb));
  /** When this window last opened a link of an action's page: a page cannot make links leave in a burst. */
  let lastLink = -Infinity;
  const api: ActionsFirefox = {
    list: () => ask("actions.liste", undefined, () => [], true),
    onChange(callback) {
      const offs = [host.on("actions.change", () => callback()), host.on("accueil.change", () => callback()), afterRestart(() => callback())];
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
    // Read without launching, check private again, open the page, then launch: in two host calls.
    async open(id, input) {
      if (isPrivate()) return denial;
      const p = await ask<{ ok: true; name: string; launch: boolean } | { ok: false; error: string } | null>("actions.preparer", { id, input: input }, () => null);
      if (isPrivate()) return denial;
      if (!p) return { ok: false, error: NO_KERNEL_MESSAGE };
      if (!p.ok) return p;
      o.dispatch({ type: "ouvrirAction", windowId: win, id, name: p.name });
      // A host that dies meanwhile: the next `acces` reads the page again, as after a rejected `ask`.
      if (p.launch) host.request("actions.lancer", { id, input: input }).catch((e) => ((hostDown = true), console.error(`[webaios] action ${id} :`, e)));
      return { ok: true };
    },
    launch: (id, input) => ask("actions.lancer", { id, input: input }, () => ({ status: "invalid" as const, error: isPrivate() ? ACTIONS_IN_PRIVATE_SPACE : NO_KERNEL_MESSAGE })),
    stop(id) {
      if (!isPrivate()) host.notify("actions.arreter", { id });
    },
    page: (id, run) => ask("actions.page", { id, execution: run }, () => null, true),
    runs: (id) => ask("actions.executions", { id }, () => [], true),
    run: (id, run) => ask("actions.execution", { id, execution: run }, () => null, true),
    direct: () => ask("actions.direct", undefined, NO_ACTION),
    onLive(callback) {
      // Only while this window's space is not private, judged at each event.
      const offFeed = host.on("actions.direct", (e) => !isPrivate() && callback(structuredClone(e)));
      // A host that started again sent no feed meanwhile: the runs are read again.
      const offs = [offFeed, afterRestart(() => void api.direct().then((e) => !isPrivate() && callback(e)))];
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
    async openLink(id, run, url) {
      if (isPrivate()) return;
      const now = Date.now();
      // A page that would open links in a burst (to make data leave): one per second at most.
      if (now - lastLink < 1000) return console.warn("[webaios] lien d'action ignoré (trop rapproché) :", url);
      // Taken now: a second click while the host checks this link is too close. A refused link gives the second back.
      const before = lastLink;
      lastLink = now;
      const allowed = await ask("actions.lienPermis", { id, execution: run, url }, () => false);
      if (allowed !== true || isPrivate()) {
        if (lastLink === now) lastLink = before;
        if (allowed !== true) console.warn("[webaios] lien d'action refusé :", url);
        return;
      }
      o.dispatch({ type: "ouvrirOnglet", windowId: win, url, activate: true });
    },
    profilesForGrant: async () => {
      const s = o.state();
      return !s || isPrivate() ? [] : profilesForGrant(s, win);
    },
    async grant(a) {
      if (isPrivate()) return denial;
      // Never a profile a private space uses: the state is read again at the moment of the grant.
      if (!readableProfiles(o.state()!).includes(a.profile)) return { ok: false, error: "Ce profil ne peut pas servir à un accord" };
      // A host that does not answer means no kernel; the kernel's own refusals come back as answers.
      const r = await host.request<{ ok: true } | { ok: false; error: string }>("actions.accorder", a).then(
        (v) => structuredClone(v),
        () => ({ ok: false as const, error: NO_KERNEL_MESSAGE }),
      );
      return isPrivate() ? denial : r;
    },
    async denyGrant(id) {
      if (isPrivate()) return;
      // The host stops the run first, then erases the grant and the results.
      await host.request("actions.refuserAccord", { id }).then(
        () => forget(id),
        (e) => ((hostDown = true), console.error(`[webaios] retrait de l'accord de l'action ${id} :`, e)),
      );
    },
    async supprimer(id) {
      if (isPrivate()) return denial;
      const r = await host.request<{ ok: true } | { ok: false; error: string }>("actions.supprimer", { id }).then(
        (v) => structuredClone(v),
        () => ((hostDown = true), { ok: false as const, error: NO_KERNEL_MESSAGE }),
      );
      if (r.ok) forget(id);
      return isPrivate() ? denial : r;
    },
    async viewWorkflow(id) {
      const name = await ask<string | null>("actions.nom", { id }, () => null);
      if (name && !isPrivate()) o.dispatch({ type: "ouvrirWorkflow", windowId: win, id, name: name, owner: "action" });
    },
    // A result image, in two halves: the host's checks, then the store's anonymous load. Never from lastRead:
    // a cached image would outlive a refusal (a deleted run, an grant given since).
    async image(id, run, url) {
      if ((await ask("actions.imagePermise", { id, execution: run, url }, () => false)) !== true) return null;
      const data = await o.media.image(url);
      return isPrivate() ? null : data;
    },
    // Each serve is paired with a release (store refcount); a private space's serve takes no reference.
    async serveComponent(name) {
      if (isPrivate()) return bump(unserved, name, 1), null;
      bump(served, name, 1);
      const url = await o.media.serve(name);
      return isPrivate() ? null : url;
    },
    releaseComponent(name) {
      if (unserved.has(name)) return bump(unserved, name, -1);
      if (!served.has(name)) return;
      bump(served, name, -1);
      void o.media.release(name);
    },
  };
  // A document that goes releases what it still shows.
  o.untilUnload(() => {
    for (const [name, n] of served) for (let i = 0; i < n; i++) void o.media.release(name);
    served.clear();
  });
  return api;
}
