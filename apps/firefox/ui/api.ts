import type { ShownSite } from "../shared/sites";
import type { ChatView } from "../shared/chat";
import type { ChangedFile, DiffFile, QuarantinedFile, Action, ApiRessac, LocalAiStateShown, AgentPanelState, ApplicationList, MaskingStatus, ShownWidget } from "../shared/api";
import type { HomeTheme } from "../../../packages/kernel/src/home/theme.ts";
import type { FreePlacement } from "../../../packages/kernel/src/home/schemas.ts";
import type { Execution, ResumeExecution } from "../../../packages/kernel/src/workflows/executions.ts";
import { format } from "../shared/i18n";
import { SHORTCUTS } from "../shared/shortcuts";
import { HOST_EXITED } from "../chrome/agent/host";
import { reauth } from "../chrome/agent/reauth";
import { validFolder } from "../chrome/store/app-folder";
import type { WindowController } from "../chrome/window/controller";

// Here, not in shared/api.ts: a value import from there pulls the Node kernel (@ressac/kernel) into the UI bundle.
export const NO_MASKING: MaskingStatus = { locked: null, lockedAgreement: "one-m", uncovered: false, uncoveredPassport: [], notice: null, passportUnreadable: [] };
import { forgetWidget, prepareWidget } from "../chrome/window/widget-frame";
import { readableProfiles, profilesForGrant, openableUrl } from "./home-profiles";
import { createActionsApi, createRecapsApi, activeSpacePrivate, type ActionsFirefox, type RecapsFirefox } from "./actions-api";
import { createSettingsApi } from "./settings-api";
import { createDesignApi, createExternalApi, createReviewApi } from "./design-api";

/** What the Firefox page reads: the widgets, plus the theme the ApiRessac type does not carry. */
export interface HomeRead {
  widgets: ShownWidget[];
  theme: HomeTheme | null;
}

/**
 * The UI's API, with the home page's read widened to carry the theme and free placements (Task 7), and
 * the actions' result images and components asked of the chrome.
 */
export interface ApiFirefox extends Omit<ApiRessac, "home" | "actions" | "recaps"> {
  actions: ActionsFirefox;
  recaps: RecapsFirefox;
  home: Omit<ApiRessac["home"], "read" | "place"> & {
    read(): Promise<HomeRead>;
    place(placements: FreePlacement[]): void;
    /** A real pointerdown in a widget's display, seen by the UI's chrome listener (not in the ApiRessac type). */
    gesture(id: string): void;
  };
  /** The design mode's cart column, opened or closed by App.svelte (ZoneContenu's rule), on the project of the active tab. */
  designPanel(isOpen: boolean): void;
  /** The cart column's « Fermer ». */
  onPanelClosed(callback: () => void): () => void;
}

declare global {
  interface Window {
    ressac: ApiFirefox;
    /** ApiRessac members the UI reached that this api does not implement (read by the e2e). */
    ressacMissingApi?: Set<string>;
  }
}

/**
 * Serves each widget's display: writes its sanitized copy under `<dataDir>/ressac-widgets/<id>/` and points `src` at
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
 * `window.ressac`, on the Firefox window controller. What is not migrated yet (applications, sites,
 * extensions, actions) answers empty; any other member is recorded in `window.ressacMissingApi` and is undefined.
 */
export function createApi(win: WindowController, o: { settingsPage?: boolean } = {}): ApiFirefox {
  const missing = (window.ressacMissingApi ??= new Set());
  // The store outlives this document: a listener into a dead document would throw on every call.
  const untilUnload = (unsubscribe: () => void) => {
    window.addEventListener("unload", unsubscribe, { once: true });
    return unsubscribe;
  };
  const host = win.store.agent;
  const windowId = win.windowId;
  const say = (id: string) => format(win.store.state.locale, id);
  const agentStopped = () => say("sidebar-api-widgets-down");
  const windowApi = { state: () => win.store.state, dispatch: (a: Action) => win.store.dispatch(a), host, window: windowId, untilUnload, media: win.store.actionMedia };
  let lastSelection: unknown; // the last workflow.selection this window sent
  /** When this window last opened a widget link: a display cannot make links leave in a burst. */
  let lastLink = 0;
  /** States this document makes itself: the host did not start, or stopped. */
  const localStates = new Set<(e: AgentPanelState) => void>();
  /** The widgets whose display this document prepared: the others' substitutions and copies are cleared. */
  const prepares = new Set<string>();
  const failed = (message: string) => localStates.forEach((cb) => cb({ state: "error", message }));
  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  /** A host request answered in this realm; `fallback` when the host does not answer (no agent). */
  const ask = <T>(method: string, params: unknown, fallback: T): Promise<T> => host.request<T>(method, params).then((r) => structuredClone(r), () => fallback);
  /** An action's builder in a window whose active space is private (or unknown), read at the moment of asking. */
  const privateAction = (target: { type: string }) => target.type === "action" && (!win.store.state || activeSpacePrivate(win.store.state, windowId));
  const activeSpace = () => win.store.state?.windows.find((f) => f.id === windowId)?.activeSpace ?? null;
  const switchAgent = (profile: string): Promise<void> => {
    win.store.dispatch({ type: "chooseAgentProfile", profile });
    return host.request("agent.switch", { window: windowId, profile }).then(() => {}, (e) => console.error("[agent] switch failed:", e));
  };
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
      write: (d, paste) => host.notify("agent.write", { window: windowId, data: d, ...(paste ? { paste: true } : {}) }),
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
      current: () => host.request<string>("agent.current", { window: windowId }).then((p) => (typeof p === "string" ? p : null), () => null),
      switch: (profile) => switchAgent(profile),
      prepareCli: (profile) => void host.request("cli.prepare", { agent: profile }).catch((e) => console.error("[agent] CLI download not started:", e)),
      relaunch: () => host.request("agent.relaunch", { window: windowId }).then(() => {}, (e) => console.error("[agent] relaunch failed:", e)),
      review: (id, choice) => host.request("agent.review", { window: windowId, id, choice }).then(() => {}, (e) => console.error("[agent] review answer failed:", e)),
      masking: () => ask("agent.masking", { window: windowId }, NO_MASKING),
      onMasking(callback) {
        const offMasking = host.on("agent.masking", () => callback());
        const offExit = host.on(HOST_EXITED, () => callback());
        return untilUnload(() => {
          offMasking();
          offExit();
        });
      },
      // Always this window's own session: the UI never names another window.
      revealLogins: (ref) =>
        host.request<unknown>("agent.revealLogins", { window: windowId, ref: String(ref) }).then((v) => (Array.isArray(v) ? v.map(String) : null), () => null),
      revealPassport: (ref) => host.request<unknown>("agent.revealPassport", { window: windowId, ref: String(ref) }).then((v) => (typeof v === "string" ? v : null), () => null),
      passportShown: async (refs) => structuredClone(win.store.passportShown(refs.map((r) => ({ profile: String(r.profile), id: String(r.id) })))),
      revealLocal: (label) => host.request<unknown>("agent.revealLocal", { window: windowId, label: String(label) }).then((v) => (typeof v === "string" ? v : null), () => null),
      maskPaste: (text) =>
        host.request<{ text?: unknown; names?: unknown } | null>("agent.maskPaste", { window: windowId, text: String(text) }).then(
          (r) => (r && typeof r.text === "string" && Array.isArray(r.names) ? { text: r.text, names: r.names.map(String) } : null),
          () => null,
        ),
      lock: {
        changed: () => host.request<ChangedFile[]>("masking.changed").then((files) => ({ ok: true as const, files: structuredClone(files) }), (e) => ({ ok: false as const, error: errorText(e) })),
        file: (path) => ask<DiffFile | null>("masking.file", { path: String(path) }, null),
        async lift(choice, remove) {
          // In the chrome, before anything leaves for the host: a page cannot skip it.
          if (!(await reauth(say("chrome-mask-reauth-lift")))) return { ok: false, error: null };
          return host.request("masking.lift", { choice, remove: remove ? [...remove] : [] }).then(() => ({ ok: true as const }), (e) => ({ ok: false as const, error: errorText(e) }));
        },
        quarantine: () => ask<QuarantinedFile[]>("masking.quarantine.list", {}, []),
        restore: (id) => host.request("masking.quarantine.restore", { id: String(id) }).then(() => ({ ok: true as const }), (e) => ({ ok: false as const, error: errorText(e) })),
      },
    },
    // The window's chat discussions, in the kernel host; routed by window like the terminal. The space is this window's active one.
    chat: {
      list: () => ask("chat.list", { window: windowId, space: activeSpace() }, []),
      open: (chatId) => host.ensure().then(() => host.request<ChatView>("chat.open", { window: windowId, space: activeSpace(), ...(chatId ? { chatId: String(chatId) } : {}) })).then((v) => structuredClone(v)),
      create: (c) => host.ensure().then(() => host.request<ChatView>("chat.create", { window: windowId, space: activeSpace(), ...(c?.profile ? { profile: String(c.profile) } : {}), ...(c?.mode ? { mode: c.mode } : {}) })).then((v) => structuredClone(v)),
      send: (draft) =>
        host.request<{ ok: true } | { ok: false; error: string }>("chat.send", { window: windowId, draft: structuredClone(draft) }).then(
          (r) => structuredClone(r),
          (e) => ({ ok: false as const, error: errorText(e) }),
        ),
      preview: (text) =>
        host.request<{ text?: unknown; names?: unknown } | null>("chat.preview", { window: windowId, text: String(text) }).then(
          (r) => (r && typeof r.text === "string" && Array.isArray(r.names) ? { text: r.text, names: r.names.map(String) } : null),
          () => null,
        ),
      cancel: () => host.notify("chat.cancel", { window: windowId }),
      answer: (requestId, reply) => host.notify("chat.answer", { window: windowId, requestId: String(requestId), reply: structuredClone(reply) }),
      retry: () => host.notify("chat.retry", { window: windowId }),
      dropPrefix: () => host.notify("chat.dropPrefix", { window: windowId }),
      review: (id, choice) => host.notify("chat.review", { window: windowId, id, choice }),
      reveal: (label) => host.request<unknown>("chat.reveal", { window: windowId, label: String(label) }).then((v) => (typeof v === "string" ? v : null), () => null),
      toTerminal: () => host.request("chat.toTerminal", { window: windowId }).then(() => {}, (e) => console.error("[chat] to terminal failed:", e)),
      toChat: () => host.request("chat.toChat", { window: windowId }).then(() => {}, (e) => console.error("[chat] back to chat failed:", e)),
      login: () => host.request("chat.login", { window: windowId }).then(() => {}, (e) => failed(errorText(e))),
    },
    onChat: (callback) => untilUnload(host.on("chat.view", (p) => p.window === windowId && callback(structuredClone(p.view)))),
    tabCycle: (m) => win.tabSwitch(m),
    navigate: (id, input) => win.navigate(id, input),
    // shortcut: zoom, find in page and devtools are out of step 2 and do nothing.
    command: (id, c) => void (typeof c === "string" && c !== "endFind" && c !== "devtools" && win.command(id, c)),
    returnFocusToPage: () => win.focusPage(),
    runShortcut: (id) => win.shortcut(SHORTCUTS[id].run),
    pagePreview: async () => null,
    // The visits live in the kernel host: the UI gets copies made in this realm.
    history: {
      search: (text, limit, distinct) => win.store.history.search(text, limit, distinct).then((v) => structuredClone(v)),
      recent: () => win.store.history.recent().then((v) => structuredClone(v)),
      clear: (from) => win.store.history.clear(from),
      forgetText: (url, spaceId) => win.store.history.forgetText(url, spaceId),
    },
    ask: {
      usable: () => win.store.ask.usable(),
      warm: () => win.store.ask.warm(),
      find: (question) => win.store.ask.find(question).then((r) => structuredClone(r)),
      handOff: (windowId, question, shown) => win.store.ask.handOff(windowId, question, shown),
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
      // The window is this document's, never the caller's: a tick counts only on its own window's card.
      answer: (id, d, rights, o) => win.store.questions.answer(id, d, o && { ...o, window: windowId }, rights),
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
    agentView: {
      state: () => structuredClone(win.store.agentView.state()),
      onState: (callback) => untilUnload(win.store.agentView.onState((s) => callback(structuredClone(s)))),
      watch: (callback) => untilUnload(win.store.agentView.watch(callback)),
      open() {
        const tab = win.store.agentView.state()?.tab;
        if (tab) win.store.dispatch({ type: "activateTab", id: tab });
      },
    },
    // The home page: widgets, their data and state, and the agent's theme, all kept by the kernel host.
    home: {
      read: async () => {
        // The host not answering rejects: an empty list is not evidence that the widgets are gone, the callers keep theirs.
        const r = structuredClone((await host.request<HomeRead>("home.read")) ?? { widgets: [], theme: null });
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
        if (!win.store.widgetGestures.accept(windowId, id)) return console.warn("[ressac] widget link ignored (no click in the widget):", url);
        const now = Date.now();
        if (now - lastLink < 1000) return console.warn("[ressac] widget link ignored (too soon):", url);
        if (!openableUrl(url)) return console.warn("[ressac] widget link refused:", url);
        lastLink = now;
        win.store.dispatch({ type: "openTab", windowId: windowId, url, activate: true });
      },
      profilesForGrant: async () => profilesForGrant(win.store.state, windowId, (id, args) => format(win.store.state.locale, id, args)),
      grant: async (a) => {
        // The state is read again at the moment of the grant: never a private space's profile.
        if (!readableProfiles(win.store.state).includes(a.profile)) return { ok: false as const, error: say("sidebar-api-profile-grant") };
        return host.request<{ ok: true } | { ok: false; error: string }>("home.grant", a).then(
          (r) => structuredClone(r),
          (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
        );
      },
      approveReads: (a) =>
        host.request<{ ok: true } | { ok: false; error: string }>("home.approveReads", a).then(
          (r) => structuredClone(r),
          (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
        ),
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
            .catch((e) => console.error("[ressac] app review :", e));
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
            .catch((e) => console.error("[ressac] site review :", e));
        // AI off: no prefill for the agent (it would show once AI is on), only the panel and its asleep card.
        if (action === "edit" && !win.store.state.settings.aiEnabled) return win.openAgent();
        host.notify("sites.act", { id, action, window: windowId });
        if (action === "edit") win.openAgent();
      },
      showHome(id) {
        const state = win.store.state;
        const favorite = state.essentials.find((f) => f.site === id);
        const tab = favorite && Object.values(state.tabs).find((t) => t.windowId === windowId && t.link?.type === "essential" && t.link.id === favorite.id);
        // A tab without its XUL tab yet starts on the home anyway (sites.attachTab).
        const browser = tab && win.browserOf(tab.id);
        if (browser) win.store.sites.showTabHome(browser);
      },
      hasHome: (id) => win.store.sites.tabHasHome(id),
    },
    // The section « Projets externes »: the external MCP server, kept by the kernel host.
    external: createExternalApi({ host, window: windowId, dispatch: (a) => win.store.dispatch(a), untilUnload }),
    // The local AI's state.
    ai: {
      state: () => ask<LocalAiStateShown>("ai.state", undefined, { state: "error", error: say("sidebar-api-agent-silent") }),
    },
    // The Review page: its comparisons and comments, kept by the kernel host.
    review: createReviewApi({ host }),
    settings: createSettingsApi({
      host,
      chrome: win.store.settings,
      sitePermissions: win.store.sitePermissions,
      dispatch: (a) => win.store.dispatch(a),
      windowId,
      openAgent: () => win.openAgent(),
      switchAgent,
      dataDir: win.store.dataDir,
      locale: () => win.store.state.locale,
      ...(o.settingsPage ? { passport: win.store.passport, passwords: win.store.passwords, passportImport: win.store.passportImport } : {}),
      spaces: () => win.store.state.spaces,
      untilUnload,
    }),
    // Import from another browser: the chrome runs the engine's migrators; answers copied into this realm.
    bookmarks: { search: (text, limit) => win.store.bookmarks.search(text, limit).then((v) => structuredClone(v)) },
    browserImport: {
      sources: () => win.store.browserImport.sources().then((r) => structuredClone(r)),
      profiles: (source) => win.store.browserImport.profiles(source).then((r) => structuredClone(r)),
      access: (source) => win.store.browserImport.access(source),
      grantAccess: (source) => win.store.browserImport.grantAccess(source).then((r) => structuredClone(r)),
      start: (o) => win.store.browserImport.start(structuredClone(o)).then((r) => structuredClone(r)),
      progress: () => win.store.browserImport.progress().then((r) => structuredClone(r)),
      importPasswordsCsv: () => win.store.browserImport.importPasswordsCsv().then((r) => structuredClone(r)),
    },
    // The design mode of this window's tab; its cart column is a chrome frame (chrome/window/design-overlays.ts).
    design: createDesignApi({ win, untilUnload }),
    // « Cacher pour l'agent »: the button only arms the viewfinder; the gesture's frames get their own API (hide-layer.ts).
    hide: { toggle: () => win.hide.toggle(), picking: () => win.hide.picking(), onChange: (cb) => untilUnload(win.hide.onChange(() => cb())) },
    designPanel(isOpen) {
      const t = { type: "window" as const, windowId: windowId };
      if (isOpen === true) void win.store.design.openCart(t);
      else if (isOpen === false) win.store.design.closeOverlay(t, "basket");
    },
    onPanelClosed: (callback) => untilUnload(win.store.design.overlays.onColumnClosed({ type: "window", windowId: windowId }, () => callback())),
    // The workflow builder: its reads and writes in the kernel host. An action's is refused in a private space with the
    // shapes of the builder's answers; its reads are checked again once answered.
    workflow: {
      catalog: () => ask("workflow.catalog", undefined, []),
      read: async (target) => (privateAction(target) ? null : ask("workflow.read", { target: target }, null).then((r) => (privateAction(target) ? null : r))),
      save: async (target, draft) =>
        privateAction(target)
          ? { ok: false, error: say("action-private"), warnings: [] }
          : ask("workflow.save", { target: target, draft: draft }, { ok: false, error: agentStopped(), warnings: [] }),
      readCode: async (target, name) =>
        privateAction(target)
          ? { error: say("action-private") }
          : ask("workflow.readCode", { target: target, name: name }, { error: agentStopped() }).then((r) => (privateAction(target) ? { error: say("action-private") } : r)),
      saveCode: async (target, name, text) =>
        privateAction(target) ? { ok: false, error: say("action-private") } : ask("workflow.saveCode", { target: target, name: name, text: text }, { ok: false, error: agentStopped() }),
      replay: async (target, run, block) =>
        privateAction(target) ? { ok: false, error: say("action-private") } : ask("workflow.replay", { target: target, run: run, block: block }, { ok: false, error: agentStopped() }),
      run: async (target, input) => (privateAction(target) ? { error: say("action-private") } : ask("workflow.run", { target: target, input: input ?? null }, {})),
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
    // The actions and the recaps: the window state's half here (private spaces, dispatches), the disk and kernel's in the host.
    actions: createActionsApi(windowApi),
    recaps: createRecapsApi(windowApi),
  };
  return new Proxy(api, {
    get(target, key) {
      if (typeof key === "string" && !(key in target)) missing.add(key);
      return Reflect.get(target, key);
    },
  }) as ApiFirefox;
}
