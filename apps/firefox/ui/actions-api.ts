import type { Action, ApiRessac } from "../shared/api";
import type { BrowserState, WindowId } from "../shared/model";
import { HOST_EXITED, type AgentHost } from "../chrome/agent/host";
import type { RessacStore } from "../chrome/store";
import { format } from "../shared/i18n";
import { readableProfiles, profilesForGrant } from "./home-profiles";

// The window half of the actions service: private spaces, dispatches, the pace of
// links, the direct feed's filter and the grant profiles. The disk and kernel half is the host's (host/actions.ts).

/** A missing window or space counts as private. */
export function activeSpacePrivate(appState: Pick<BrowserState, "spaces" | "windows">, f: WindowId): boolean {
  const win = appState.windows.find((x) => x.id === f);
  return !win || (appState.spaces.find((e) => e.id === win.activeSpace)?.private ?? true);
}

/** The actions API, plus what the Firefox page asks the chrome for: result images and agent components. */
export type ActionsFirefox = ApiRessac["actions"] & {
  image(id: string, execution: string, url: string): Promise<string | null>;
  serveComponent(name: string): Promise<string | null>;
  releaseComponent(name: string): void;
  /** An action or component folder changed, or the host restarted: not a widget harvest (`home.change`), which never touches a component. */
  onComponentChange(callback: () => void): () => void;
};

/** The recaps API, plus their images asked of the chrome. */
export type RecapsFirefox = ApiRessac["recaps"] & { image(id: string, url: string): Promise<string | null> };

type WindowApiOptions = {
  state: () => BrowserState | undefined;
  dispatch: (a: Action) => void;
  host: AgentHost;
  window: WindowId;
  untilUnload: (unsubscribe: () => void) => () => void;
  media: RessacStore["actionMedia"];
};

/**
 * Opens a page's link in an active tab once the host allows it. One per second at most: a page cannot make links leave
 * in a burst. Taken at the click: a second click while the host checks is too close; a refused link gives it back.
 */
function pacedLinks(o: WindowApiOptions, isPrivate: () => boolean) {
  let last = -Infinity;
  return async (url: string, allowed: () => Promise<boolean>): Promise<void> => {
    if (isPrivate()) return;
    const now = Date.now();
    if (now - last < 1000) return console.warn("[ressac] page link ignored (too soon):", url);
    const before = last;
    last = now;
    const ok = await allowed();
    if (ok !== true || isPrivate()) {
      if (last === now) last = before;
      if (ok !== true) console.warn("[ressac] page link refused:", url);
      return;
    }
    o.dispatch({ type: "openTab", windowId: o.window, url, activate: true });
  };
}

/** The window half of the recaps: nothing in a private space, links paced, images through the actions' anonymous loader. */
export function createRecapsApi(o: WindowApiOptions): RecapsFirefox {
  const isPrivate = () => {
    const s = o.state();
    return !s || activeSpacePrivate(s, o.window);
  };
  // Checked before and after the host answers: the window may have moved to a private space meanwhile.
  const ask = async <T>(method: string, params: unknown, empty: T): Promise<T> => {
    if (isPrivate()) return empty;
    const r = await o.host.request<T>(method, params).then((v) => structuredClone(v), () => empty);
    return isPrivate() ? empty : r;
  };
  const open = pacedLinks(o, isPrivate);
  let hostDown = false;
  o.untilUnload(o.host.on(HOST_EXITED, () => (hostDown = true)));
  return {
    page: (id) => ask("recaps.page", { id }, null),
    openLink: (id, url) => open(url, () => ask("recaps.linkAllowed", { id, url }, false)),
    onChange(callback) {
      const offs = [
        o.host.on("recaps.changed", (p) => !isPrivate() && callback(String((p as { id?: unknown } | undefined)?.id))),
        // A host that started again (its kernel's first `access`): the pages read again.
        o.host.on("access", () => hostDown && ((hostDown = false), callback(null))),
      ];
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
    // Never cached: an image must not outlive a closed recap.
    async image(id, url) {
      if ((await ask("recaps.imageAllowed", { id, url }, false)) !== true) return null;
      const data = await o.media.image(url);
      return isPrivate() ? null : data;
    },
  };
}

const NO_ACTION = () => ({ running: [], waiting: [] });

export function createActionsApi(o: WindowApiOptions): ActionsFirefox {
  const { host, window: win } = o;
  /** Read at each call and again after each wait: the window may have moved to a private space meanwhile. */
  const isPrivate = () => {
    const s = o.state();
    return !s || activeSpacePrivate(s, win);
  };
  const say = (id: string) => format(o.state()?.locale ?? "fr", id);
  const noKernel = () => say("chrome-actions-no-kernel");
  const privateDenial = () => ({ ok: false as const, error: say("action-private") });
  /** The host stopped or did not answer a request: the next `access` reads again (afterRestart). */
  let hostDown = false;
  /** The `access` handled so far: a refusal answered before one of them but handled after it still reads again. */
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
   * The host stopped, or did not answer this API (a page opened while it was down): the first `access`, sent once its
   * kernel runs again, calls the subscribers back once. Meanwhile pages keep their last read; later `access` (each policy
   * change) are ignored.
   */
  const restarted = new Set<() => void>();
  const readAgain = () => restarted.forEach((cb) => cb());
  o.untilUnload(host.on(HOST_EXITED, () => (hostDown = true)));
  o.untilUnload(
    host.on("access", () => {
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
      if (method === "actions.list" || params?.id === id) lastRead.delete(key);
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
  const openPaced = pacedLinks(o, isPrivate);
  const api: ActionsFirefox = {
    list: () => ask("actions.list", undefined, () => [], true),
    onChange(callback) {
      const offs = [host.on("actions.change", () => callback()), host.on("home.change", () => callback()), afterRestart(() => callback())];
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
    onComponentChange(callback) {
      const offs = [host.on("actions.change", () => callback()), afterRestart(() => callback())];
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
    // Read without launching, check private again, open the page, then launch: in two host calls.
    async open(id, input) {
      if (isPrivate()) return privateDenial();
      const p = await ask<{ ok: true; name: string; launch: boolean } | { ok: false; error: string } | null>("actions.prepare", { id, input: input }, () => null);
      if (isPrivate()) return privateDenial();
      if (!p) return { ok: false, error: noKernel() };
      if (!p.ok) return p;
      o.dispatch({ type: "openAction", windowId: win, id, name: p.name });
      // A host that dies meanwhile: the next `access` reads the page again, as after a rejected `ask`.
      if (p.launch) host.request("actions.launch", { id, input: input }).catch((e) => ((hostDown = true), console.error(`[ressac] action ${id} :`, e)));
      return { ok: true };
    },
    launch: (id, input) => ask("actions.launch", { id, input: input }, () => ({ status: "invalid" as const, error: isPrivate() ? say("action-private") : noKernel() })),
    stop(id) {
      if (!isPrivate()) host.notify("actions.stop", { id });
    },
    page: (id, run) => ask("actions.page", { id, run }, () => null, true),
    runs: (id) => ask("actions.runs", { id }, () => [], true),
    run: (id, run) => ask("actions.run", { id, run }, () => null, true),
    live: () => ask("actions.live", undefined, NO_ACTION),
    onLive(callback) {
      // Only while this window's space is not private, judged at each event.
      const offFeed = host.on("actions.live", (e) => !isPrivate() && callback(structuredClone(e)));
      // A host that started again sent no feed meanwhile: the runs are read again.
      const offs = [offFeed, afterRestart(() => void api.live().then((e) => !isPrivate() && callback(e)))];
      return o.untilUnload(() => offs.forEach((f) => f()));
    },
    openLink: (id, run, url) => openPaced(url, () => ask("actions.linkAllowed", { id, run, url }, () => false)),
    profilesForGrant: async () => {
      const s = o.state();
      return !s || isPrivate() ? [] : profilesForGrant(s, win, (id, args) => format(s.locale, id, args));
    },
    async grant(a) {
      if (isPrivate()) return privateDenial();
      // Never a profile a private space uses: the state is read again at the moment of the grant.
      if (!readableProfiles(o.state()!).includes(a.profile)) return { ok: false, error: say("chrome-actions-profile-refused") };
      // A host that does not answer means no kernel; the kernel's own refusals come back as answers.
      const r = await host.request<{ ok: true } | { ok: false; error: string }>("actions.grant", a).then(
        (v) => structuredClone(v),
        () => ({ ok: false as const, error: noKernel() }),
      );
      return isPrivate() ? privateDenial() : r;
    },
    async approveReads(a) {
      if (isPrivate()) return privateDenial();
      const r = await host.request<{ ok: true } | { ok: false; error: string }>("actions.approveReads", a).then(
        (v) => structuredClone(v),
        () => ({ ok: false as const, error: noKernel() }),
      );
      return isPrivate() ? privateDenial() : r;
    },
    async denyGrant(id) {
      if (isPrivate()) return;
      // The host stops the run first, then erases the grant and the results.
      await host.request("actions.denyGrant", { id }).then(
        () => forget(id),
        (e) => ((hostDown = true), console.error(`[ressac] grant removal of action ${id}:`, e)),
      );
    },
    async delete(id) {
      if (isPrivate()) return privateDenial();
      const r = await host.request<{ ok: true } | { ok: false; error: string }>("actions.delete", { id }).then(
        (v) => structuredClone(v),
        () => ((hostDown = true), { ok: false as const, error: noKernel() }),
      );
      if (r.ok) forget(id);
      return isPrivate() ? privateDenial() : r;
    },
    async viewWorkflow(id) {
      const name = await ask<string | null>("actions.name", { id }, () => null);
      if (name && !isPrivate()) o.dispatch({ type: "openWorkflow", windowId: win, id, name: name, owner: "action" });
    },
    // A result image, in two halves: the host's checks, then the store's anonymous load. Never from lastRead:
    // a cached image would outlive a refusal (a deleted run, an grant given since).
    async image(id, run, url) {
      if ((await ask("actions.imageAllowed", { id, run, url }, () => false)) !== true) return null;
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
