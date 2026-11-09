import type { ShownSite } from "../shared/sites";
import type { ApiWebaios, AgentPanelState, ApplicationList, ExtensionResult, ShownWidget } from "../shared/api";
import type { ExtensionLine, SpaceExtensionLine } from "../shared/extensions";
import type { HomeTheme } from "../../../packages/kernel/src/home/theme.ts";
import type { FreePlacement } from "../../../packages/kernel/src/home/schemas.ts";
import type { Execution, ResumeExecution } from "../../../packages/kernel/src/workflows/executions.ts";
import { HOST_EXITED } from "../chrome/agent/host";
import { validFolder } from "../chrome/store/app-folder";
import type { WindowController } from "../chrome/window/controller";
import { forgetWidget, prepareWidget } from "../chrome/window/widget-frame";
import { readableProfiles, profilesForGrant, openableUrl } from "./home-profiles";
import { ACTIONS_IN_PRIVATE_SPACE } from "../shared/actions";
import { createActionsApi, activeSpacePrivate, type ActionsFirefox } from "./actions-api";
import { createDesignApi, createExternalApi, createReviewApi } from "./design-api";

/** What the Firefox page reads: the widgets, plus the theme the ApiWebaios type does not carry. */
export interface HomeRead {
  widgets: ShownWidget[];
  theme: HomeTheme | null;
}

/**
 * The UI's API, with the home page's read widened to carry the theme and free placements (Task 7), and
 * the actions' result images and components asked of the chrome.
 */
export interface ApiFirefox extends Omit<ApiWebaios, "home" | "actions"> {
  actions: ActionsFirefox;
  home: Omit<ApiWebaios["home"], "read" | "place"> & {
    read(): Promise<HomeRead>;
    place(placements: FreePlacement[]): void;
    /** A real pointerdown in a widget's display, seen by the UI's chrome listener (not in the ApiWebaios type). */
    gesture(id: string): void;
  };
  /** The design mode's cart column, opened or closed by App.svelte (ZoneContenu's rule), on the project of the active tab. */
  designPanel(isOpen: boolean): void;
  /** The cart column's « Fermer ». */
  onPanelClosed(callback: () => void): () => void;
}

declare global {
  interface Window {
    webaios: ApiFirefox;
    /** ApiWebaios members the UI reached that this api does not implement (read by the e2e). */
    webaiosMissingApi?: Set<string>;
  }
}

// Same text as host/host.ts's (a Node module this bundle cannot import).
const AGENT_STOPPED_MESSAGE = "Le service des widgets ne répond pas (agent arrêté ?)";

/**
 * Serves each widget's display: writes its sanitized copy under `<dataDir>/webaios-widgets/<id>/` and points `src` at
 * its resource:// URL. The widgets served last time and gone now lose their substitution and their copies.
 */
export async function serveDisplays(
  widgets: ShownWidget[],
  dataDir: string,
  prepares: Set<string>,
  tool: {
    prepare: (dataDir: string, id: string) => Promise<string | null>;
    forget: (dataDir: string, id: string) => Promise<void>;
  } = { prepare: prepareWidget, forget: forgetWidget },
): Promise<void> {
  const now = new Set<string>();
  await Promise.all(
    widgets.map(async (w) => {
      if (!("src" in w) || w.src === null) return;
      const url = await tool.prepare(dataDir, w.id);
      w.src = url;
      if (url) now.add(w.id);
    }),
  );
  for (const id of prepares) if (!now.has(id)) await tool.forget(dataDir, id);
  prepares.clear();
  for (const id of now) prepares.add(id);
}

/**
 * `window.webaios`, on the Firefox window controller. What is not migrated yet (applications, sites,
 * extensions, actions) answers empty; any other member is recorded in `window.webaiosMissingApi` and is undefined.
 */
export function createApi(win: WindowController): ApiFirefox {
  const missing = (window.webaiosMissingApi ??= new Set());
  // The store outlives this document: a listener into a dead document would throw on every call.
  const untilUnload = (unsubscribe: () => void) => {
    window.addEventListener("unload", unsubscribe, { once: true });
    return unsubscribe;
  };
  const host = win.store.agent;
  const windowId = win.windowId;
  let lastSelection: unknown; // the last workflow.selection this window sent
  /** When this window last opened a widget link: a display cannot make links leave in a burst. */
  let lastLink = 0;
  /** States this document makes itself: the host did not start, or stopped. */
  const localStates = new Set<(e: AgentPanelState) => void>();
  /** The widgets whose display this document prepared: the others' substitutions and copies are cleared. */
  const prepares = new Set<string>();
  const failed = (message: string) => localStates.forEach((cb) => cb({ state: "error", message }));
  /** An extension action in the kernel host; its answer copied into this realm, a failure given back as text. */
  const extension = (method: string, params: Record<string, unknown>) =>
    host.request<ExtensionResult>(method, params).then((r) => structuredClone(r), (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  /** A host request answered in this realm; `fallback` when the host does not answer (no agent). */
  const ask = <T>(method: string, params: unknown, fallback: T): Promise<T> => host.request<T>(method, params).then((r) => structuredClone(r), () => fallback);
  /** An action's builder in a window whose active space is private (or unknown), read at the moment of asking. */
  const privateAction = (target: { type: string }) => target.type === "action" && (!win.store.state || activeSpacePrivate(win.store.state, windowId));
  const api: Partial<ApiFirefox> = {
    windowId: win.windowId,
    // A tab the user closes may ask first (beforeunload).
    dispatch: (action) => void (action.type === "closeTab" ? win.closeTab(action.id) : win.store.dispatch(action)),
    onState(callback) {
      // The state lives in the store's realm: the UI always gets its own copy, made in this realm.
      const send = () => callback(structuredClone(win.store.state));
      if (win.store.state) send();
      return untilUnload(win.store.subscribe(send));
    },
    onShortcut: (callback) => untilUnload(win.onShortcut(callback)),
    onPanel: (callback) => untilUnload(win.onPanel(callback)),
    onTabsPanel: (callback) => untilUnload(win.onTabPanel((p) => callback(p && structuredClone(p)))),
    onLeftZone: (callback) => untilUnload(win.onLeftZone(callback)),
    // The window's terminal session, in the kernel host. Its output and states are routed by window.
    agent: {
      start(size) {
        // Starts the host again if it stopped (Réessayer after a crash).
        host
          .ensure()
          .then(() => host.request("agent.start", { window: windowId, size: size }))
          .catch((e) => failed(e instanceof Error ? e.message : String(e)));
      },
      write: (d) => host.notify("agent.write", { window: windowId, data: d }),
      resize: (size) => host.notify("agent.resize", { window: windowId, size: size }),
      onData: (callback) => untilUnload(host.on("agent.data", (p) => p.window === windowId && callback(String(p.data)))),
      onState(callback) {
        localStates.add(callback);
        const offState = host.on("agent.state", (p) => p.window === windowId && callback(structuredClone(p.state)));
        const offExit = host.on(HOST_EXITED, (p) => callback({ state: "error", message: p.message }));
        return untilUnload(() => {
          localStates.delete(callback);
          offState();
          offExit();
        });
      },
      profiles: () => host.request<{ id: string; name: string }[]>("agent.profiles").then((p) => structuredClone(p), () => []),
    },
    tabCycle: (m) => win.tabSwitch(m),
    navigate: (id, input) => win.navigate(id, input),
    // shortcut: zoom, find in page and devtools are out of step 2 and do nothing.
    command: (id, c) => void (typeof c === "string" && c !== "endFind" && c !== "devtools" && win.command(id, c)),
    returnFocusToPage: () => win.focusPage(),
    pagePreview: async () => null,
    // The visits live in the kernel host: the UI gets copies made in this realm.
    history: {
      search: (text, limit, distinct) => win.store.history.search(text, limit, distinct).then((v) => structuredClone(v)),
      recent: () => win.store.history.recent().then((v) => structuredClone(v)),
      clear: (from) => win.store.history.clear(from),
      forgetText: (url, spaceId) => win.store.history.forgetText(url, spaceId),
    },
    // The list lives in the store's realm: the UI gets copies made in this realm.
    downloads: {
      list: async () => structuredClone(win.store.downloads.list()),
      open: (id) => win.store.downloads.open(id),
      show: (id) => win.store.downloads.show(id),
      cancel: (id) => win.store.downloads.cancel(id),
    },
    onDownloads: (callback) => untilUnload(win.store.downloads.onChange((l) => callback(structuredClone(l)))),
    // The agent's cards and access badges live in the store's realm: the UI gets copies made in this realm.
    permissions: {
      pending: async () => structuredClone(win.store.questions.pending()),
      answer: (id, d, rights, o) => win.store.questions.answer(id, d, o, rights),
    },
    onPermissions: (callback) => untilUnload(win.store.questions.onChange((l) => callback(structuredClone(l)))),
    access: {
      state: async () => structuredClone(win.store.access),
      cut: (id, right) => host.notify("policy.cut", { id, right: right }),
    },
    onAccess(callback) {
      const send = () => callback(structuredClone(win.store.access));
      const offAccess = host.on("access", send);
      const offExit = host.on(HOST_EXITED, send);
      return untilUnload(() => {
        offAccess();
        offExit();
      });
    },
    // The home page: widgets, their data and state, and the agent's theme, all kept by the kernel host.
    home: {
      read: async () => {
        let r: HomeRead;
        try {
          r = structuredClone((await host.request<HomeRead>("home.read")) ?? { widgets: [], theme: null });
        } catch {
          // The host did not answer: an empty list is not evidence that the widgets are gone.
          return { widgets: [], theme: null };
        }
        await serveDisplays(r.widgets, win.store.dataDir, prepares);
        return r;
      },
      onChange: (callback) => untilUnload(host.on("home.change", () => callback())),
      place: (placements) => host.notify("home.place", { placements }),
      gesture: (id) => win.store.widgetGestures.gesture(windowId, id),
      remove: (id) => host.notify("home.remove", { id }),
      open: (url, id) => {
        // Only just after a real click in this widget's display (one link per click), and one per second at most: a
        // display that would burst links could make data leave.
        if (!win.store.widgetGestures.accept(windowId, id)) return console.warn("[webaios] lien de widget ignoré (pas de clic dans le widget) :", url);
        const now = Date.now();
        if (now - lastLink < 1000) return console.warn("[webaios] lien de widget ignoré (trop rapproché) :", url);
        if (!openableUrl(url)) return console.warn("[webaios] lien de widget refusé :", url);
        lastLink = now;
        win.store.dispatch({ type: "openTab", windowId: windowId, url, activate: true });
      },
      profilesForGrant: async () => profilesForGrant(win.store.state, windowId),
      grant: async (a) => {
        // The state is read again at the moment of the grant: never a private space's profile.
        if (!readableProfiles(win.store.state).includes(a.profile)) return { ok: false as const, error: "Ce profil ne peut pas servir à un accord" };
        return host.request<{ ok: true } | { ok: false; error: string }>("home.grant", a).then(
          (r) => structuredClone(r),
          (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
        );
      },
      denyGrant: (id) => host.notify("home.denyGrant", { id }),
      harvest: (id) => host.notify("home.harvest", { id }),
      runs: (id) =>
        host.request<ResumeExecution[]>("home.runs", { id }).then(
          (v) => structuredClone(v),
          () => [],
        ),
      run: (id, run) =>
        host.request<Execution | null>("home.run", { id, run }).then(
          (v) => structuredClone(v),
          () => null,
        ),
    },
    // The agent's applications, kept by the kernel host (its windows through the chrome). The host checks every action
    // with SchemaActionApplication; « Afficher le dossier » is the chrome's (one path segment), « Relire » the UI's.
    apps: {
      list: () => ask<ApplicationList>("apps.list", undefined, { workshop: "ok", apps: [] }),
      onChange(callback) {
        // A host that started again, or the chrome's resync, sent no change: the list is read again.
        const offs = [host.on("apps.change", () => callback()), host.on(HOST_EXITED, () => callback()), host.on("home.change", () => callback())];
        return untilUnload(() => offs.forEach((f) => f()));
      },
      act(folder, action) {
        if (action === "folder") return win.store.apps.reveal(folder);
        // The app's Review page, under its name; a project without manifest has none.
        if (action === "review") {
          if (!validFolder(folder)) return;
          return void api.apps!.list()
            .then((l) => {
              const a = l.apps.find((x) => x.folder === folder);
              if (a && a.type !== "no-manifest") win.store.dispatch({ type: "openReview", windowId: windowId, project: "app-" + folder, name: a.name.slice(0, 80) });
            })
            .catch((e) => console.error("[webaios] app review :", e));
        }
        // « Déboguer »: the host pre-fills the terminal and opens the panel (design.donnerAgent).
        host.notify("apps.act", { folder: folder, action, window: windowId });
      },
    },
    // The site apps, kept by the kernel host (its window actions go through the chrome); « Afficher le dossier » and
    // « Relire » are the UI's own.
    sites: {
      list: () => ask<ShownSite[]>("sites.list", undefined, []),
      onChange(callback) {
        // A host that started again, or the chrome's resync, sent no change: the list is read again.
        const offs = [host.on("sites.change", () => callback()), host.on(HOST_EXITED, () => callback()), host.on("home.change", () => callback())];
        return untilUnload(() => offs.forEach((f) => f()));
      },
      act(id, action) {
        if (action === "folder") return win.store.sites.revealSite(id);
        // The app's Review page, under its name.
        if (action === "review")
          return void api.sites!.list()
            .then((l) => win.store.dispatch({ type: "openReview", windowId: windowId, project: "site-" + id, name: (l.find((s) => s.id === id)?.name ?? id).slice(0, 80) }))
            .catch((e) => console.error("[webaios] site review :", e));
        host.notify("sites.act", { id, action, window: windowId });
        if (action === "edit") win.openAgent();
      },
    },
    // The section « Projets externes »: the external MCP server, kept by the kernel host.
    external: createExternalApi({ host, window: windowId, dispatch: (a) => win.store.dispatch(a), untilUnload }),
    // The Review page: its comparisons and comments, kept by the kernel host.
    review: createReviewApi({ host }),
    // The design mode of this window's tab; its cart column is a chrome frame (chrome/window/design-overlays.ts).
    design: createDesignApi({ win, untilUnload }),
    designPanel(isOpen) {
      const t = { type: "fenetre" as const, windowId: windowId };
      if (isOpen === true) void win.store.design.openCart(t);
      else if (isOpen === false) win.store.design.closeOverlay(t, "basket");
    },
    onPanelClosed: (callback) => untilUnload(win.store.design.overlays.onColumnClosed({ type: "fenetre", windowId: windowId }, () => callback())),
    // The agent's extensions, kept by the kernel host: what the reused space modal, empty page and command bar call.
    extensions: {
      forSpace: (spaceId) => host.request<SpaceExtensionLine[]>("extensions.forSpace", { spaceId: spaceId }).then((l) => structuredClone(l), () => []),
      toggle: (key, spaceId, active) => extension("extensions.toggle", { key: key, spaceId: spaceId, active: active, window: windowId }),
      onChange: (callback) => untilUnload(host.on("extensions.change", () => callback())),
      // The Extensions page: the agent's extensions only (decision 8); AMO add-ons stay in about:addons.
      list: () => host.request<ExtensionLine[]>("extensions.list").then((l) => structuredClone(l), () => []),
      allCut: () => host.request<boolean>("extensions.allCut").then((b) => b === true, () => false),
      disableEverywhere: (key) => extension("extensions.disableEverywhere", { key: key }),
      remove: (key) => extension("extensions.remove", { key: key }),
      cutAll: (yes) => extension("extensions.cutAll", { yes: yes }),
      review: (key) => extension("extensions.review", { key: key, window: windowId }),
      reenable: (key) => extension("extensions.reenable", { key: key }),
      cutUnlock: (key) => extension("extensions.cutUnlock", { key: key }),
      installStore: () => extension("extensions.installStore", {}),
    } as Partial<ApiWebaios["extensions"]> as ApiWebaios["extensions"],
    // The workflow builder: its reads and writes in the kernel host. An action's is refused in a private space with the
    // shapes of the builder's answers; its reads are checked again once answered.
    workflow: {
      catalog: () => ask("workflow.catalog", undefined, []),
      read: async (target) => (privateAction(target) ? null : ask("workflow.read", { target: target }, null).then((r) => (privateAction(target) ? null : r))),
      save: async (target, draft) =>
        privateAction(target)
          ? { ok: false, error: ACTIONS_IN_PRIVATE_SPACE, warnings: [] }
          : ask("workflow.save", { target: target, draft: draft }, { ok: false, error: AGENT_STOPPED_MESSAGE, warnings: [] }),
      readCode: async (target, name) =>
        privateAction(target)
          ? { error: ACTIONS_IN_PRIVATE_SPACE }
          : ask("workflow.readCode", { target: target, name: name }, { error: AGENT_STOPPED_MESSAGE }).then((r) => (privateAction(target) ? { error: ACTIONS_IN_PRIVATE_SPACE } : r)),
      saveCode: async (target, name, text) =>
        privateAction(target) ? { ok: false, error: ACTIONS_IN_PRIVATE_SPACE } : ask("workflow.saveCode", { target: target, name: name, text: text }, { ok: false, error: AGENT_STOPPED_MESSAGE }),
      replay: async (target, run, block) =>
        privateAction(target) ? { ok: false, error: ACTIONS_IN_PRIVATE_SPACE } : ask("workflow.replay", { target: target, run: run, block: block }, { ok: false, error: AGENT_STOPPED_MESSAGE }),
      run: async (target, input) => (privateAction(target) ? { error: ACTIONS_IN_PRIVATE_SPACE } : ask("workflow.run", { target: target, input: input ?? null }, {})),
      selection(target, block) {
        // The host keeps it in memory only: resent on `access`, which a host sends once its kernel has started (and on policy
        // changes, harmless: the same selection again).
        if (!lastSelection) untilUnload(host.on("access", () => host.notify("workflow.selection", lastSelection)));
        lastSelection = { window: windowId, target: target, block: block };
        host.notify("workflow.selection", lastSelection);
      },
      live: () => ask("workflow.live", undefined, { running: [], waiting: [] }),
      onLive(callback) {
        // A host that stopped or started again sent no feed meanwhile: the runs are read again.
        const again = () => void api.workflow!.live().then(callback);
        const offs = [host.on("workflow.live", (e) => callback(structuredClone(e))), host.on(HOST_EXITED, again), host.on("home.change", again)];
        return untilUnload(() => offs.forEach((f) => f()));
      },
    },
    // The actions: the window state's half here (private spaces, dispatches), the disk and kernel's in the host.
    actions: createActionsApi({ state: () => win.store.state, dispatch: (a) => win.store.dispatch(a), host, window: windowId, untilUnload, media: win.store.actionMedia }),
  };
  return new Proxy(api, {
    get(target, key) {
      if (typeof key === "string" && !(key in target)) missing.add(key);
      return Reflect.get(target, key);
    },
  }) as ApiFirefox;
}
