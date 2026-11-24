import type { Scope } from "../../../../packages/kernel/src/index.ts";
import type { ExtensionCard } from "../../shared/extensions";
import { agentAllowedHost, agentAllowedUrl } from "../../core/extensions/network";
import { isSensitive } from "../../../../packages/kernel/src/access/sensitive";
import { onPassportHost } from "../passport/hosts";
import type { AccessState, WindowId, ProfileId } from "../../shared/model";
import type { Handler } from "../../shared/rpc";
import type { AgentHost } from "../agent/host";
import type { Questions } from "../agent/questions";
import { existingContainer } from "./containers";
import { createWatchdog } from "./crash-watchdog";
import { consoleLevel, MAX_CRASHES } from "../../core/extensions/consoles";
import type { Store } from "./store";
import type { WindowRegistry } from "./windows";
import { testEnv } from "../test-env";

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");

// Keep in sync with host/extensions/firefox-copy.ts ID_SUFFIX.
const SUFFIX = "@agent.ressac";
const isAgentId = (id: string) => id.endsWith(SUFFIX);
const EXEMPT = "extensions.quarantineIgnoredByUser.";
const REFUSED_CALLS = new Set(["tabs.captureVisibleTab", "tabs.captureTab", "tabs.detectLanguage", "tabs.saveAsPDF", "tabs.print", "tabs.printPreview", "tabs.toggleReaderMode"]);
// Keep in sync with chrome/window/tabs.ts (not imported: it runs window code at load).
const TAB_ID = "ressac-tab-id";
const PARKING = "ressac-parking";
// Keep in sync with CONSOLE_LENGTH_MAX (packages/kernel/src/mcp/extensions.ts): a message is never longer than an answer.
const CONSOLE_TEXT_MAX = 100_000;

/** An uncaught error of its background window this close to its start is a failed load (spike S7). */
const LOAD_WINDOW_MS = 1_000;
/** A background stopped this shortly before the extension process crash was running in it (its status comes first). */
const STOPPED_BY_CRASH_MS = 2_000;
const BACKGROUND_PAGE = "/_generated_background_page.html";

/** How long a checkpoint waits for the first grants (the host starting) before it refuses. */
export const SCOPES_WAIT_MS = 5_000;

export type CheckKind = "urlAllowed" | "hostAllowed" | "isTab";
type Scopes = Record<string, { key: string; grant: Scope; profiles: ProfileId[]; active: boolean }>;

export interface AgentExtensions {
  /** The requests the kernel host sends about its extensions (extensions.*, navigateur.espaces). */
  readonly handlers: Record<string, Handler>;
  /** Each new host process: extensions.pret, with the about:addons changes it has not acknowledged yet. */
  hostStarted(): void;
  /** Settled once the first host answered extensions.pret (the granted extensions handled). */
  readonly ready: Promise<void>;
  /** Settled once a host sent the grants (extensions.portees), or after SCOPES_WAIT_MS: then check refuses what it does not know. */
  scopesKnown(): Promise<void>;
  /** The bar lists an agent add-on only where it runs; any other everywhere. */
  shownIn(addonId: string, profile: ProfileId, isPrivate: boolean): boolean;
  /** `cb` after each new set of grants (extensions.portees). */
  onScopes(cb: () => void): () => void;
  /** The extension actor's checkpoints (window.__ressac), for the add-on id read from the page's principal. */
  check(addonId: string, kind: CheckKind, value: unknown): boolean;
  /** The console actor's message from content process `from`: relayed to the kernel for an installed agent extension. */
  relayConsole(from: { childID: number; remoteType: string }, data: unknown): void;
}

/** Firefox's side of the agent's extensions: the kernel host decides, this installs, enables, disables, uninstalls. */
export function createAgentExtensions(store: Store, windows: WindowRegistry, questions: Questions, host: () => AgentHost, access: () => AccessState): AgentExtensions {
  // The add-on changes this module is making, as `<addonId> <quoi>`: only those AddonManager events are ours. A removal
  // in about:addons while we install or reload the same add-on is still the user's (an install fires no uninstall event).
  const ours = new Set<string>();
  const own = async <T>(addonId: string, what: "uninstalled" | "disabled", f: () => Promise<T>): Promise<T> => {
    const key = `${addonId} ${what}`;
    ours.add(key);
    try {
      return await f();
    } finally {
      ours.delete(key);
    }
  };
  // Seen from AddonManager: an immediate uninstall under way (onUninstalling to onUninstalled), and about:addons' Undo.
  const uninstalling = new Set<string>();
  const undone = new Set<string>();
  const agentId = (addonId: string) => {
    if (typeof addonId !== "string" || !addonId.endsWith(SUFFIX)) throw new Error(`Pas une extension de l'agent : ${addonId}`);
    return addonId;
  };
  // Firefox's quarantine keeps the agent's extensions off the user's sensitive sites (masking): the per-add-on exemption
  // about:addons offers never holds for one. Reset at startup, whenever it is set, and on each evaluation (extensions.enable).
  const noExemption = (addonId: string) => {
    const pref = EXEMPT + addonId;
    if (isAgentId(addonId) && Services.prefs.getBoolPref(pref, false)) Services.prefs.setBoolPref(pref, false);
  };
  for (const pref of Services.prefs.getChildList(EXEMPT)) noExemption(pref.slice(EXEMPT.length));
  Services.prefs.addObserver(EXEMPT, (_: unknown, __: string, pref: string) => noExemption(pref.slice(EXEMPT.length)));

  const handlers: Record<string, Handler> = {
    // Inactive (decision 4): never installed fresh; an upgrade keeps the disabled state, so it is disabled first.
    "extensions.install": async (p: { addonId: string; xpi: string; temporary: boolean; version: string; active: boolean }) => {
      const id = agentId(p.addonId);
      const present = await AddonManager.getAddonByID(id);
      if (!p.active && !present) return null;
      if (present && present.version === p.version) return { version: present.version };
      return own(id, "disabled", async () => {
        if (!p.active && !present.userDisabled) await present.disable();
        let path = p.xpi;
        if (p.temporary) {
          // A temporary add-on is read from its file for as long as it runs: a copy of ours, which the kernel moves.
          const dir = PathUtils.join(PathUtils.tempDir, "ressac-agent-addons");
          await IOUtils.makeDirectory(dir, { ignoreExisting: true });
          path = PathUtils.join(dir, `${id}-${p.version}.xpi`);
          await IOUtils.copy(p.xpi, path);
        }
        const file = new FileUtils.File(path);
        const addon = p.temporary ? await AddonManager.installTemporaryAddon(file) : await (await AddonManager.getInstallForFile(file)).install();
        if (addon?.id !== id) {
          await addon?.uninstall();
          throw new Error(`Module inattendu : ${addon?.id}`);
        }
        return { version: addon.version };
      });
    },
    // reload_extension on an unchanged copy: the running add-on restarts as is (disable then enable), nothing signed again.
    "extensions.restart": async (p: { addonId: string }) => {
      const addon = await AddonManager.getAddonByID(agentId(p.addonId));
      if (addon?.isActive) await own(addon.id, "disabled", () => addon.reload());
    },
    "extensions.enable": async (p: { addonId: string; active: boolean }) => {
      const addon = await AddonManager.getAddonByID(agentId(p.addonId));
      noExemption(p.addonId);
      if (!addon || addon.userDisabled === !p.active) return;
      await own(addon.id, "disabled", () => (p.active ? addon.enable() : addon.disable()));
    },
    // `unlessUndone`: a removal from about:addons; kept (false) only if its Undo came. An add-on present again without an
    // Undo was installed back by the kernel before the removal reached it: uninstalled again.
    "extensions.uninstall": async (p: { addonId: string; unlessUndone?: boolean }) => {
      const addon = await AddonManager.getAddonByID(agentId(p.addonId));
      if (addon && p.unlessUndone && undone.has(addon.id)) return false;
      // An immediate uninstall still finishing: Firefox completes it.
      if (addon && !uninstalling.has(addon.id)) await own(addon.id, "uninstalled", () => addon.uninstall());
      return true;
    },
    // The grant card, in that window if still open, else the active one; no window: it falls at once.
    "extensions.grant": (p: { card: ExtensionCard; window: string | null }, signal) => {
      const f = p.window && windows.get(p.window) ? p.window : windows.active();
      return f ? questions.askExtension(p.card, f, signal) : { accepted: false, removed: true };
    },
    // The console unlock card, in that window if still open, else the active one; no window: it falls at once.
    "extensions.unlock": (p: { name: string; spaces: string[]; reason: string; agent: string; window: WindowId | null }, signal) => {
      const f = p.window && windows.get(p.window) ? p.window : windows.active();
      return f ? questions.askConsole(p, f, signal) : "withdrawn";
    },
    // Firefox's own add-ons for list_extensions (decision 7): AMO extensions, not the agent's, nor built-in, system or hidden ones.
    "extensions.amo": async () =>
      (await AddonManager.getAddonsByTypes(["extension"]))
        .filter((a: { id: string; isBuiltin: boolean; isSystem: boolean; hidden: boolean }) => !isAgentId(a.id) && !a.isBuiltin && !a.isSystem && !a.hidden)
        .map((a: { id: string; name: string; version: string; isActive: boolean }) => ({ id: a.id, name: a.name, version: a.version, active: a.isActive })),
    "browser.spaces": () => ({
      spaces: store.state.spaces,
      windows: store.state.windows.filter((f) => windows.get(f.id)).map((f) => ({ id: f.id, activeSpace: f.activeSpace })),
      foreground: windows.active() ?? null,
    }),
  };

  // about:addons changes not acknowledged by a host: sent again with the next extensions.pret, so none is lost while no host runs.
  const pending = new Map<string, "uninstalled" | "disabled">();
  const send = (addonId: string, what: "uninstalled" | "disabled") =>
    host()
      .request("extensions.outsideRessac", { addonId, what: what })
      .then(() => pending.get(addonId) === what && pending.delete(addonId))
      .catch(() => {});
  AddonManager.addAddonListener({
    // about:addons' Remove is uninstall(true): only onUninstalling fires until the page unloads, maybe at quit. The
    // removal is handled from it; the kernel completes the uninstall unless Undo came first.
    onUninstalling: (a: { id: string; temporarilyInstalled: boolean; pendingOperations: number }) => {
      undone.delete(a.id);
      if (!(a.pendingOperations & AddonManager.PENDING_UNINSTALL)) uninstalling.add(a.id);
      outside(a, "uninstalled");
    },
    onUninstalled: (a: { id: string; temporarilyInstalled: boolean }) => {
      uninstalling.delete(a.id);
      outside(a, "uninstalled");
    },
    onOperationCancelled: (a: { id: string }) => void undone.add(a.id),
    onDisabled: (a: { id: string; temporarilyInstalled: boolean }) => outside(a, "disabled"),
  });
  function outside(addon: { id: string; temporarilyInstalled: boolean }, what: "uninstalled" | "disabled") {
    // Quitting unloads temporary add-ons: not a choice made in about:addons.
    if (!addon.id.endsWith(SUFFIX) || ours.has(`${addon.id} ${what}`) || (addon.temporarilyInstalled && Services.startup.shuttingDown)) return;
    pending.set(addon.id, what);
    void send(addon.id, what);
  }

  let scopes: Scopes = {};
  let scopesSettle = () => {};
  const scopesSent = new Promise<void>((r) => (scopesSettle = r));
  let scopesArrived = false;
  void scopesSent.then(() => (scopesArrived = true));
  const scopesKnown = () => (scopesArrived ? scopesSent : Promise.race([scopesSent, new Promise<void>((r) => setTimeout(r, SCOPES_WAIT_MS))]));
  const scopeListeners = new Set<() => void>();
  handlers["extensions.scopes"] = (p: Scopes) => {
    scopes = p;
    scopesSettle();
    for (const cb of scopeListeners) cb();
  };
  const tabOf = (tabId: unknown) => {
    if (typeof tabId !== "number") return null;
    try {
      return ExtensionParent.apiManager.global.tabTracker.getTab(tabId);
    } catch {
      return null; // Unknown id: getTab throws.
    }
  };

  /** A Ressac tab's state entry and space; never the parking tab, never an invisible read (not a tab at all). */
  const tabModelOf = (tab: any) => {
    const tabModel = !tab || tab.hasAttribute?.(PARKING) ? undefined : store.state.tabs[tab.getAttribute?.(TAB_ID) ?? ""];
    const space = tabModel && store.state.spaces.find((e) => e.id === tabModel.spaceId);
    return tabModel && space ? { tab: tabModel, space: space } : null;
  };

  // The tabs each agent extension's scripts were let into: a profile turned private reloads
  // them (rechargerOngletsAgent), whatever the extension's state now: switched off there, its scripts still run.
  const ran = new Map<string, Set<any>>();
  /** Reloads the tabs of `profils` that `addonId` (every agent extension if null) ran in; forgets the closed ones. */
  const reloadTabs = (addonId: string | null, profiles: readonly ProfileId[]) => {
    const containers = new Set(profiles.map(existingContainer).filter((c) => c !== null));
    for (const [id, tabs] of ran)
      for (const tab of tabs) {
        if (!tab.isConnected || !tab.linkedBrowser) tabs.delete(tab);
        else if ((addonId === null || id === addonId) && containers.has(tab.userContextId)) {
          tabs.delete(tab);
          tab.linkedBrowser.reload();
        }
      }
  };
  handlers["extensions.reloadTabs"] = (p: { addonId: string; profiles: ProfileId[] }) => {
    if (typeof p?.addonId === "string" && Array.isArray(p.profiles)) reloadTabs(p.addonId, p.profiles);
  };

  // A profile turned private: its agent-script tabs reload here at once, host or not; the kernel takes it out of the
  // registry (extensions.profilsPrives, sent at each change of that set, and at each host start).
  const privateProfiles = () => [...new Set(store.state.spaces.filter((e) => e.private).map((e) => e.profile))].sort();
  const sendPrivate = () => host().notify("extensions.privateProfiles", { profiles: privateProfiles() });
  let lastPrivate = privateProfiles();
  store.subscribe((state, previous) => {
    const now = privateProfiles();
    // A tab closed: forget it (its element would stay alive in `ran`).
    if (Object.keys(state.tabs).length < Object.keys(previous.tabs).length) reloadTabs(null, []);
    if (now.join("\n") === lastPrivate.join("\n")) return;
    const turned = now.filter((p) => !lastPrivate.includes(p));
    lastPrivate = now;
    if (turned.length > 0) reloadTabs(null, turned);
    sendPrivate();
  });

  // Once per extension and profile; a request that fails (no host) is sent again on the next check.
  const maskedSent = new Set<string>();
  const masked = (addonId: string, profile: ProfileId) => {
    const key = `${addonId}|${profile}`;
    if (maskedSent.has(key)) return;
    maskedSent.add(key);
    host()
      .request("extensions.ran", { addonId, profile: profile, readable: false })
      .catch(() => maskedSent.delete(key));
  };

  function check(addonId: string, kind: CheckKind, value: unknown): boolean {
    const scope = Object.hasOwn(scopes, addonId) ? scopes[addonId]! : null;
    if (!scope?.active) return false;
    switch (kind) {
      case "urlAllowed": {
        // Relative: within the extension. Its own pages only; anything else through agentAllowedUrl.
        const host = WebExtensionPolicy.getByID(addonId)?.mozExtensionHostname;
        if (typeof value !== "string" || !host) return false;
        let u: URL;
        try {
          u = new URL(value, `moz-extension://${host}/`);
        } catch {
          return false;
        }
        // A passport host is a source (design § 6.1): the agent's extensions never reach it.
        return u.protocol === "moz-extension:" ? u.host === host : agentAllowedUrl(u.href, scope.grant, "") && !onPassportHost(u.href);
      }
      case "hostAllowed": {
        const spec = tabOf(value)?.linkedBrowser?.currentURI?.spec;
        // A sensitive page (a subdomain or a path Firefox's exact-host quarantine misses): never injected, first visit included.
        return typeof spec === "string" && agentAllowedHost(spec, scope.grant) && !isSensitive(spec) && !onPassportHost(spec);
      }
      case "isTab": {
        // A Ressac tab of a non-private space, in the container of a profile where the extension is active (spec choice
        // 2: its content scripts follow its spaces). `<tab>:<frame>` from the guard; a bare number comes from a copy signed
        // before the frame check (Firefox starts it before the host): refused until it is signed again.
        const target = typeof value === "string" ? /^(\d+):(\d+|\*)$/.exec(value) : null;
        if (!target) return false;
        const tab = tabOf(Number(target[1]));
        const t = tabModelOf(tab);
        if (!t || t.space.private || !scope.profiles.includes(t.space.profile) || tab.userContextId !== existingContainer(t.space.profile)) return false;
        if (!framesReadable(tab, target[2]!)) return false;
        // Its scripts will run there: a tab the agent cannot read masks its console for good.
        if (!access().tabs[t.tab.id]?.read) masked(addonId, t.space.profile);
        ran.set(addonId, (ran.get(addonId) ?? new Set()).add(tab));
        return true;
      }
    }
    return false;
  }

  /**
   * Masking: no frame from the targeted one (frameId 0 the top, else its BrowsingContext id; `*` every frame) up to the
   * top is sensitive, by its principal (an about:blank or srcdoc child inherits its parent's and can read it) and its address.
   */
  function framesReadable(tab: any, frame: string): boolean {
    const top = tab.linkedBrowser?.browsingContext;
    if (!top) return false;
    const all: any[] = top.getAllBrowsingContextsInSubtree();
    const picked = frame === "*" ? all : [frame === "0" ? top : all.find((bc) => String(bc.id) === frame)];
    const sensitive = (bc: any) => {
      const w = bc.currentWindowGlobal;
      const specs = [w?.documentPrincipal?.URI?.spec ?? "", w?.documentURI?.spec ?? ""];
      // A passport host is a source too: its frames are refused like a sensitive page's.
      return specs.some((spec) => isSensitive(spec) || (spec !== "" && spec !== "about:blank" && onPassportHost(spec)));
    };
    for (let bc of picked) {
      if (!bc) return false;
      for (; bc; bc = bc.parent) if (sensitive(bc)) return false;
    }
    return true;
  }

  /**
   * A console message an agent extension wrote in a content process (spike S6): from the extension
   * process, its own pages (`onglet` null); from a web process, a content script: the Ressac tab of a non-private space
   * it came from (else none), whose readability the kernel decides as it notes it (its policy,
   * ongletLisibleParAgent). A web process is untrusted: the window must be one of its own, looked up here.
   */
  function relayConsole(from: { childID: number; remoteType: string }, data: unknown): void {
    const d = (data ?? {}) as { addonId?: unknown; level?: unknown; text?: unknown; innerWindowID?: unknown };
    // Any installed agent add-on (its background runs before its grant is written): never an invented id.
    if (typeof d.addonId !== "string" || !d.addonId.endsWith(SUFFIX) || !WebExtensionPolicy.getByID(d.addonId)) return;
    if (typeof d.level !== "string" || typeof d.text !== "string") return;
    let tabModel: { tabId: string | null; url: string } | null = null;
    if (from.remoteType === "extension" && d.level === "error") {
      // Its background window's error (or console.error): half of a load error, the parent's console has the other.
      const wgp = typeof d.innerWindowID === "number" ? WindowGlobalParent.getByInnerWindowId(d.innerWindowID) : null;
      const spec = wgp?.domProcess?.childID === from.childID && wgp.documentPrincipal?.addonId === d.addonId ? wgp.documentURI?.spec : null;
      if (typeof spec === "string" && new URL(spec).pathname === BACKGROUND_PAGE) crashes.backgroundError(d.addonId, String((d as { source?: unknown }).source ?? ""), d.text);
    }
    if (from.remoteType !== "extension") {
      const wgp = typeof d.innerWindowID === "number" ? WindowGlobalParent.getByInnerWindowId(d.innerWindowID) : null;
      const browser = wgp?.domProcess?.childID === from.childID ? wgp.browsingContext.top.embedderElement : null;
      const t = tabModelOf(browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser));
      // The address of the page that wrote it, as the parent knows it: never a later one the tab moved to.
      const url = wgp?.topWindowContext?.documentURI?.spec;
      tabModel = t && !t.space.private && typeof url === "string" ? { tabId: t.tab.id, url } : { tabId: null, url: "" };
    }
    const m = { timestamp: Date.now(), level: consoleLevel(d.level === "warn" ? "warning" : d.level), text: d.text.slice(0, CONSOLE_TEXT_MAX) };
    host().notify("extensions.console", { addonId: d.addonId, message: m, tab: tabModel });
  }

  // The network guard beyond the copy's CSP: every http(s) request an agent
  // extension loads or starts, of any type (navigation, window, a redirect of one, but also what Firefox's parent loads
  // for it, such as a notification icon, which no CSP sees), goes only where urlAllowed says. Fail closed before the
  // grants arrive. Content scripts carry an expanded principal (no addonId): not concerned.
  Services.obs.addObserver((subject: any) => {
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    const info = channel.loadInfo;
    const addonId: string = info.loadingPrincipal?.addonId || info.triggeringPrincipal?.addonId || "";
    if (isAgentId(addonId) && !check(addonId, "urlAllowed", channel.URI.spec)) channel.cancel(Cr.NS_BINDING_ABORTED);
  }, "http-on-modify-request");
  // Firefox grants activeTab to an MV3 extension on a click of its button, its menu
  // item or its command even without the right (originControls): refused in the parent, for every page of the agent's
  // extensions (background, popup, tabs), before Firefox looks at the call.
  // The conduit bound its recv methods at startup: its APICall entry is the one to wrap.
  const api = ExtensionParent.ParentAPIManager;
  const recvAPICall = api.conduit.recv.get("APICall");
  api.conduit.recv.set("APICall", (data: { childId: number; callId?: number; path: string }, meta: unknown) => {
    if (REFUSED_CALLS.has(data.path) && isAgentId(api.getContextUnchecked(data.childId)?.extension?.id ?? "")) {
      if (data.callId) api.conduit.sendCallResult(data.childId, { childId: data.childId, callId: data.callId, path: data.path, error: { message: `${data.path} non pris en charge par Ressac` } });
      return;
    }
    return recvAPICall(data, meta);
  });
  // runtime.setUninstallURL: Firefox opens it with a null principal when the add-on goes, so it is read through
  // urlAllowed then (null: no tab). Hooked on each agent extension as it starts, and on those already running.
  // The parking tab is no tab for an agent extension: tabs.query, tabs.get, windows.getAll and the tab events never list it, even with the
  // tabs right. Nor a tab of a private space: an agent extension never runs in a private space. Nor a sensitive tab (masking).
  // canAccessTab is what Firefox's TabManager asks before it wraps any tab for the extension.
  const guardExtension = (extension: { id: string; uninstallURL: string | null; tabManager: { canAccessTab(tab: any): boolean } }) => {
    if (!isAgentId(extension?.id ?? "")) return;
    const manager = extension.tabManager;
    const canAccess = manager.canAccessTab.bind(manager);
    // A sensitive tab too: its address and title (a webmail's is an e-mail address) would reach the agent past the masker.
    const sensitive = (tab: any) => [tab.linkedBrowser?.currentURI?.spec ?? "", tabModelOf(tab)?.tab.url ?? ""].some((u) => isSensitive(u) || onPassportHost(u));
    manager.canAccessTab = (tab) => !tab.hasAttribute(PARKING) && !tabModelOf(tab)?.space.private && !sensitive(tab) && canAccess(tab);
    let url = extension.uninstallURL;
    Object.defineProperty(extension, "uninstallURL", {
      get: () => (url && check(extension.id, "urlAllowed", url) ? url : null),
      set: (v: string | null) => void (url = v),
      configurable: true,
    });
  };
  ExtensionParent.apiManager.on("startup", (_: string, extension: any) => guardExtension(extension));
  for (const policy of WebExtensionPolicy.getActiveExtensions()) if (policy.extension) guardExtension(policy.extension);

  // Crashes not acknowledged by a host: sent again with the next extensions.pret, at most PLANTAGES_MAX per extension.
  const crashesPending: { addonId: string; at: number }[] = [];
  const crashes = watchCrashes((addonId) => {
    const c = { addonId, at: Date.now() };
    crashesPending.push(c);
    const mine = crashesPending.filter((x) => x.addonId === addonId);
    if (mine.length > MAX_CRASHES) crashesPending.splice(crashesPending.indexOf(mine[0]!), 1);
    host()
      .request("extensions.crash", c)
      .then(() => crashesPending.includes(c) && crashesPending.splice(crashesPending.indexOf(c), 1))
      .catch(() => {});
  });

  let settle = () => {};
  const ready = new Promise<void>((r) => (settle = r));
  return {
    handlers,
    ready,
    scopesKnown,
    shownIn(addonId, profile, isPrivate) {
      if (!isAgentId(addonId)) return true;
      const scope = Object.hasOwn(scopes, addonId) ? scopes[addonId]! : null;
      return !isPrivate && !!scope?.active && scope.profiles.includes(profile);
    },
    onScopes(cb) {
      scopeListeners.add(cb);
      return () => void scopeListeners.delete(cb);
    },
    check,
    relayConsole,
    hostStarted() {
      sendPrivate();
      const sent = [...pending].map(([addonId, what]) => ({ addonId, what: what }));
      const crashes = [...crashesPending];
      host()
        .request("extensions.ready", { outsideRessac: sent, crashes: crashes })
        .then(
          () => {
            sent.forEach((h) => pending.get(h.addonId) === h.what && pending.delete(h.addonId));
            for (const c of crashes) if (crashesPending.includes(c)) crashesPending.splice(crashesPending.indexOf(c), 1);
          },
          (e) => console.error("[extensions] agent extensions not started:", e),
        )
        .finally(settle);
    },
  };
}

/**
 * The agent's extensions' crashes, as Firefox shows them (spike S7: no platform event names the extension), each one
 * `crashed(addonId)` once: an uncaught error of its background window within LOAD_WINDOW_MS of its start; the extension
 * process crashing while its background runs; that process hung while it runs (the watchdog kills it, which is the crash
 * above). The whole process stops every background in it: each agent one running is counted, whichever caused it.
 */
function watchCrashes(crashed: (addonId: string) => void): { backgroundError(addonId: string, source: string, text: string): void } {
  const running = new Set<string>();
  const stopped = new Map<string, number>();
  // Its background's last start and its last load error, either may come first: one crash per start.
  const loads = new Map<string, { started: number | null; error: number | null; counted: boolean }>();
  const load = (addonId: string, what: "started" | "error") => {
    const l = loads.get(addonId) ?? { started: null, error: null, counted: false };
    loads.set(addonId, l);
    if (what === "started") Object.assign(l, { started: ChromeUtils.now(), counted: false });
    else if (l.counted) return;
    else l.error = ChromeUtils.now();
    if (l.started !== null && l.error !== null && Math.abs(l.started - l.error) <= LOAD_WINDOW_MS) {
      Object.assign(l, { error: null, counted: true });
      crashed(addonId);
    }
  };
  // The same uncaught error arrives twice: in the parent's console (uncaught for sure, but with no window: spike S6) and
  // relayed by the console actor (its window, but a console.error looks the same). Both halves, by file and text: a load error.
  const halves = new Map<string, { side: "uncaught" | "window"; at: number }>();
  const half = (addonId: string, source: string, text: string, side: "uncaught" | "window") => {
    const now = ChromeUtils.now();
    for (const [k, h] of halves) if (now - h.at > LOAD_WINDOW_MS) halves.delete(k);
    const key = `${addonId}\n${source}\n${text}`;
    const other = halves.get(key);
    if (other && other.side !== side) {
      halves.delete(key);
      load(addonId, "error");
    } else halves.set(key, { side, at: now });
  };

  Services.obs.addObserver((subject: any) => {
    const { addonId, isRunning } = subject?.wrappedJSObject ?? {};
    if (typeof addonId !== "string" || !addonId.endsWith(SUFFIX)) return;
    if (isRunning) {
      running.add(addonId);
      stopped.delete(addonId);
      load(addonId, "started");
      watchdog.start();
    } else if (running.delete(addonId)) {
      stopped.set(addonId, ChromeUtils.now());
      if (running.size === 0) watchdog.stop();
    }
  }, "extension:background-script-status");

  Services.console.registerListener({
    observe(m: any) {
      if (!(m instanceof Ci.nsIScriptError) || m.flags & Ci.nsIScriptError.warningFlag) return;
      const source = String(m.sourceName);
      const host = /^moz-extension:\/\/([^/]+)\//.exec(source)?.[1];
      const id = host ? WebExtensionPolicy.getByHostname(host)?.id : null;
      if (id?.endsWith(SUFFIX)) half(id, source, String(m.errorMessage), "uncaught");
    },
  });

  const { Management, ExtensionProcessCrashObserver } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
  Management.on("extension-process-crash", () => {
    const now = ChromeUtils.now();
    for (const [addonId, at] of stopped) if (now - at <= STOPPED_BY_CRASH_MS) running.add(addonId);
    stopped.clear();
    for (const addonId of running) crashed(addonId);
    running.clear();
    watchdog.stop();
  });

  let pinged: ReturnType<typeof ChromeUtils.getAllDOMProcesses>[number] | undefined;
  const testWindow = Number(testEnv("RESSAC_TEST_WATCHDOG_MS"));
  const watchdog = createWatchdog({
    // e2e only (three kills in 60 s); floored so it can never make the watchdog trigger-happy.
    ...(testWindow > 0 ? { windowMs: Math.max(testWindow, 2_000) } : {}),
    now: () => ChromeUtils.now(),
    setTimer: (f, ms) => setTimeout(f, ms),
    clearTimer: (t) => clearTimeout(t),
    active: () => running.size > 0 && !Services.startup.shuttingDown,
    ping: () => {
      pinged = ChromeUtils.getAllDOMProcesses().find((x) => x.remoteType === "extension");
      const p = pinged;
      return p ? Promise.resolve().then(() => p.getActor("RessacConsole").sendQuery("ping")) : Promise.resolve();
    },
    kill: () => {
      if (!pinged?.canSend || running.size === 0) return;
      // Firefox stops respawning the extension process past its threshold of crashes (none comes back until a restart).
      const timeframe = Services.prefs.getIntPref("extensions.webextensions.crash.timeframe", 30_000);
      const recent = (ExtensionProcessCrashObserver.lastCrashTimestamps ?? []).filter((t: number) => ChromeUtils.now() - t < timeframe).length;
      if (recent >= Services.prefs.getIntPref("extensions.webextensions.crash.threshold", 5) - 1) {
        console.error("[extensions] the extension process stopped answering, not killed: Firefox would stop respawning it");
        return;
      }
      console.error("[extensions] the extension process stopped answering while an agent extension ran: killed");
      Cc["@mozilla.org/processtools-service;1"].getService(Ci.nsIProcessToolsService).kill(pinged.osPid);
    },
  });
  Services.obs.addObserver(() => watchdog.wake(), "wake_notification");

  return { backgroundError: (addonId, source, text) => half(addonId, source, text, "window") };
}
