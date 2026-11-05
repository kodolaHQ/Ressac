import type { Portee } from "../../../../packages/noyau/src/index.ts";
import type { CarteExtension } from "../../../navigateur/src/commun/extensions";
import { hotePermisAgent, urlPermiseAgent } from "../../../navigateur/src/main/extensions/reseau";
import type { EtatAcces, IdFenetre, IdProfil } from "../../../navigateur/src/commun/modele";
import type { Handler } from "../../shared/rpc";
import type { AgentHost } from "../agent/host";
import type { Questions } from "../agent/questions";
import { existingContainer } from "./containers";
import { createWatchdog } from "./crash-watchdog";
import { niveauConsole, PLANTAGES_MAX } from "../../../navigateur/src/main/extensions/consoles";
import type { Store } from "./store";
import type { WindowRegistry } from "./windows";

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");

// Keep in sync with noyau/extensions/copie-firefox.ts SUFFIXE_ID.
const SUFFIX = "@agent.webaios";
const REFUSED_CALLS = new Set(["tabs.captureVisibleTab", "tabs.captureTab", "tabs.detectLanguage", "tabs.saveAsPDF", "tabs.print", "tabs.printPreview", "tabs.toggleReaderMode"]);
// Keep in sync with chrome/window/tabs.ts (not imported: it runs window code at load).
const TAB_ID = "webaios-tab-id";
const PARKING = "webaios-parking";
// Keep in sync with LONGUEUR_CONSOLE_MAX (packages/noyau/src/mcp/extensions.ts): a message is never longer than an answer.
const CONSOLE_TEXT_MAX = 100_000;

/** An uncaught error of its background window this close to its start is a failed load (spike S7). */
const LOAD_WINDOW_MS = 1_000;
/** A background stopped this shortly before the extension process crash was running in it (its status comes first). */
const STOPPED_BY_CRASH_MS = 2_000;
const BACKGROUND_PAGE = "/_generated_background_page.html";

/** How long a checkpoint waits for the first grants (the host starting) before it refuses. */
export const SCOPES_WAIT_MS = 5_000;

export type CheckKind = "urlPermise" | "hotePermis" | "estOnglet";
type Scopes = Record<string, { cle: string; accord: Portee; profils: IdProfil[]; actif: boolean }>;

export interface AgentExtensions {
  /** The requests the noyau host sends about its extensions (extensions.*, navigateur.espaces). */
  readonly handlers: Record<string, Handler>;
  /** Each new host process: extensions.pret, with the about:addons changes it has not acknowledged yet. */
  hostStarted(): void;
  /** Settled once the first host answered extensions.pret (the granted extensions handled). */
  readonly ready: Promise<void>;
  /** Settled once a host sent the grants (extensions.portees), or after SCOPES_WAIT_MS: then check refuses what it does not know. */
  scopesKnown(): Promise<void>;
  /** The extension actor's checkpoints (window.__webaios), for the add-on id read from the page's principal. */
  check(addonId: string, kind: CheckKind, value: unknown): boolean;
  /** The console actor's message from content process `from`: relayed to the noyau for an installed agent extension. */
  relayConsole(from: { childID: number; remoteType: string }, data: unknown): void;
}

/** Firefox's side of the agent's extensions: the noyau host decides, this installs, enables, disables, uninstalls. */
export function createAgentExtensions(store: Store, windows: WindowRegistry, questions: Questions, host: () => AgentHost, access: () => EtatAcces): AgentExtensions {
  // Add-ons this module is changing: their AddonManager events are ours, not about:addons'.
  const ours = new Set<string>();
  const own = async <T>(addonId: string, f: () => Promise<T>): Promise<T> => {
    ours.add(addonId);
    try {
      return await f();
    } finally {
      ours.delete(addonId);
    }
  };
  const agentId = (addonId: string) => {
    if (typeof addonId !== "string" || !addonId.endsWith(SUFFIX)) throw new Error(`Pas une extension de l'agent : ${addonId}`);
    return addonId;
  };

  const handlers: Record<string, Handler> = {
    // Inactive (decision 4): never installed fresh; an upgrade keeps the disabled state, so it is disabled first.
    "extensions.installer": async (p: { addonId: string; xpi: string; temporaire: boolean; version: string; actif: boolean }) => {
      const id = agentId(p.addonId);
      const present = await AddonManager.getAddonByID(id);
      if (!p.actif && !present) return null;
      if (present && present.version === p.version) return { version: present.version };
      return own(id, async () => {
        if (!p.actif && !present.userDisabled) await present.disable();
        let path = p.xpi;
        if (p.temporaire) {
          // A temporary add-on is read from its file for as long as it runs: a copy of ours, which the noyau moves.
          const dir = PathUtils.join(PathUtils.tempDir, "webaios-agent-addons");
          await IOUtils.makeDirectory(dir, { ignoreExisting: true });
          path = PathUtils.join(dir, `${id}-${p.version}.xpi`);
          await IOUtils.copy(p.xpi, path);
        }
        const file = new FileUtils.File(path);
        const addon = p.temporaire ? await AddonManager.installTemporaryAddon(file) : await (await AddonManager.getInstallForFile(file)).install();
        if (addon?.id !== id) {
          await addon?.uninstall();
          throw new Error(`Module inattendu : ${addon?.id}`);
        }
        return { version: addon.version };
      });
    },
    "extensions.activer": async (p: { addonId: string; actif: boolean }) => {
      const addon = await AddonManager.getAddonByID(agentId(p.addonId));
      if (!addon || addon.userDisabled === !p.actif) return;
      await own(addon.id, () => (p.actif ? addon.enable() : addon.disable()));
    },
    // `unlessUndone`: about:addons' Remove (a pending uninstall); its Undo came first if it is no longer pending: kept, false.
    "extensions.desinstaller": async (p: { addonId: string; unlessUndone?: boolean }) => {
      const addon = await AddonManager.getAddonByID(agentId(p.addonId));
      if (addon && p.unlessUndone && !(addon.pendingOperations & AddonManager.PENDING_UNINSTALL)) return false;
      if (addon) await own(addon.id, () => addon.uninstall());
      return true;
    },
    // The grant card, in that window if still open, else the active one; no window: it falls at once.
    "extensions.accord": (p: { carte: CarteExtension; fenetre: string | null }, signal) => {
      const f = p.fenetre && windows.get(p.fenetre) ? p.fenetre : windows.active();
      return f ? questions.askExtension(p.carte, f, signal) : { accepte: false, empreinte: p.carte.empreinte, retiree: true };
    },
    // The console unlock card, in that window if still open, else the active one; no window: it falls at once.
    "extensions.deblocage": (p: { nom: string; espaces: string[]; raison: string; agent: string; fenetre: IdFenetre | null }, signal) => {
      const f = p.fenetre && windows.get(p.fenetre) ? p.fenetre : windows.active();
      return f ? questions.askConsole(p, f, signal) : "retiree";
    },
    // Firefox's own add-ons for lister_extensions (decision 7): AMO extensions, not the agent's, nor built-in, system or hidden ones.
    "extensions.amo": async () =>
      (await AddonManager.getAddonsByTypes(["extension"]))
        .filter((a: { id: string; isBuiltin: boolean; isSystem: boolean; hidden: boolean }) => !a.id.endsWith(SUFFIX) && !a.isBuiltin && !a.isSystem && !a.hidden)
        .map((a: { id: string; name: string; version: string; isActive: boolean }) => ({ id: a.id, nom: a.name, version: a.version, actif: a.isActive })),
    "navigateur.espaces": () => ({
      espaces: store.state.espaces,
      fenetres: store.state.fenetres.filter((f) => windows.get(f.id)).map((f) => ({ id: f.id, espaceActif: f.espaceActif })),
      premierPlan: windows.active() ?? null,
    }),
  };

  // about:addons changes not acknowledged by a host: sent again with the next extensions.pret, so none is lost while no host runs.
  const pending = new Map<string, "desinstallee" | "desactivee">();
  const send = (addonId: string, quoi: "desinstallee" | "desactivee") =>
    host()
      .request("extensions.horsWebaios", { addonId, quoi })
      .then(() => pending.get(addonId) === quoi && pending.delete(addonId))
      .catch(() => {});
  AddonManager.addAddonListener({
    // about:addons' Remove is uninstall(true): only onUninstalling fires until the page unloads, maybe at quit. The
    // removal is handled from it; the noyau completes the uninstall unless Undo came first.
    onUninstalling: (a: { id: string; temporarilyInstalled: boolean }) => outside(a, "desinstallee"),
    onUninstalled: (a: { id: string; temporarilyInstalled: boolean }) => outside(a, "desinstallee"),
    onDisabled: (a: { id: string; temporarilyInstalled: boolean }) => outside(a, "desactivee"),
  });
  function outside(addon: { id: string; temporarilyInstalled: boolean }, quoi: "desinstallee" | "desactivee") {
    // Quitting unloads temporary add-ons: not a choice made in about:addons.
    if (!addon.id.endsWith(SUFFIX) || ours.has(addon.id) || (addon.temporarilyInstalled && Services.startup.shuttingDown)) return;
    pending.set(addon.id, quoi);
    void send(addon.id, quoi);
  }

  let scopes: Scopes = {};
  let scopesSettle = () => {};
  const scopesSent = new Promise<void>((r) => (scopesSettle = r));
  let scopesArrived = false;
  void scopesSent.then(() => (scopesArrived = true));
  const scopesKnown = () => (scopesArrived ? scopesSent : Promise.race([scopesSent, new Promise<void>((r) => setTimeout(r, SCOPES_WAIT_MS))]));
  handlers["extensions.portees"] = (p: Scopes) => {
    scopes = p;
    scopesSettle();
  };
  const tabOf = (tabId: unknown) => {
    if (typeof tabId !== "number") return null;
    try {
      return ExtensionParent.apiManager.global.tabTracker.getTab(tabId);
    } catch {
      return null; // Unknown id: getTab throws.
    }
  };

  /** A WebAiOs tab's state entry and space; never the parking tab, never an invisible read (not a tab at all). */
  const ongletDe = (tab: any) => {
    const onglet = !tab || tab.hasAttribute?.(PARKING) ? undefined : store.state.onglets[tab.getAttribute?.(TAB_ID) ?? ""];
    const espace = onglet && store.state.espaces.find((e) => e.id === onglet.espaceId);
    return onglet && espace ? { onglet, espace } : null;
  };

  // The tabs each agent extension's scripts were let into (as Electron's suivreOnglet): a profile turned private reloads
  // them (rechargerOngletsAgent), whatever the extension's state now: switched off there, its scripts still run.
  const ran = new Map<string, Set<any>>();
  /** Reloads the tabs of `profils` that `addonId` (every agent extension if null) ran in; forgets the closed ones. */
  const reloadTabs = (addonId: string | null, profils: readonly IdProfil[]) => {
    const containers = new Set(profils.map(existingContainer).filter((c) => c !== null));
    for (const [id, tabs] of ran)
      for (const tab of tabs) {
        if (!tab.isConnected || !tab.linkedBrowser) tabs.delete(tab);
        else if ((addonId === null || id === addonId) && containers.has(tab.userContextId)) {
          tabs.delete(tab);
          tab.linkedBrowser.reload();
        }
      }
  };
  handlers["extensions.rechargerOnglets"] = (p: { addonId: string; profils: IdProfil[] }) => {
    if (typeof p?.addonId === "string" && Array.isArray(p.profils)) reloadTabs(p.addonId, p.profils);
  };

  // A profile turned private: its agent-script tabs reload here at once, host or not; the noyau takes it out of the
  // registry (extensions.profilsPrives, sent at each change of that set, and at each host start).
  const privateProfiles = () => [...new Set(store.state.espaces.filter((e) => e.prive).map((e) => e.profil))].sort();
  const sendPrivate = () => host().notify("extensions.profilsPrives", { prives: privateProfiles() });
  let lastPrivate = privateProfiles();
  store.subscribe((state, previous) => {
    const now = privateProfiles();
    // A tab closed: forget it (its element would stay alive in `ran`).
    if (Object.keys(state.onglets).length < Object.keys(previous.onglets).length) reloadTabs(null, []);
    if (now.join("\n") === lastPrivate.join("\n")) return;
    const turned = now.filter((p) => !lastPrivate.includes(p));
    lastPrivate = now;
    if (turned.length > 0) reloadTabs(null, turned);
    sendPrivate();
  });

  // Once per extension and profile; a request that fails (no host) is sent again on the next check.
  const maskedSent = new Set<string>();
  const masked = (addonId: string, profil: IdProfil) => {
    const key = `${addonId}|${profil}`;
    if (maskedSent.has(key)) return;
    maskedSent.add(key);
    host()
      .request("extensions.aTourne", { addonId, profil, lisible: false })
      .catch(() => maskedSent.delete(key));
  };

  function check(addonId: string, kind: CheckKind, value: unknown): boolean {
    const scope = Object.hasOwn(scopes, addonId) ? scopes[addonId]! : null;
    if (!scope?.actif) return false;
    switch (kind) {
      case "urlPermise": {
        // Relative: within the extension. Its own pages only; anything else as Electron's urlPermiseAgent.
        const host = WebExtensionPolicy.getByID(addonId)?.mozExtensionHostname;
        if (typeof value !== "string" || !host) return false;
        let u: URL;
        try {
          u = new URL(value, `moz-extension://${host}/`);
        } catch {
          return false;
        }
        return u.protocol === "moz-extension:" ? u.host === host : urlPermiseAgent(u.href, scope.accord, "");
      }
      case "hotePermis": {
        const spec = tabOf(value)?.linkedBrowser?.currentURI?.spec;
        return typeof spec === "string" && hotePermisAgent(spec, scope.accord);
      }
      case "estOnglet": {
        // A WebAiOs tab of a non-private space, in the container of a profile where the extension is active (spec choice
        // 2: its content scripts follow its spaces; Electron loads it in that profile's session only).
        const tab = tabOf(value);
        const t = ongletDe(tab);
        if (!t || t.espace.prive || !scope.profils.includes(t.espace.profil) || tab.userContextId !== existingContainer(t.espace.profil)) return false;
        // Its scripts will run there: a tab the agent cannot read masks its console for good (as Electron's aTourneDansOnglet).
        if (!access().onglets[t.onglet.id]?.lecture) masked(addonId, t.espace.profil);
        ran.set(addonId, (ran.get(addonId) ?? new Set()).add(tab));
        return true;
      }
    }
    return false;
  }

  /**
   * A console message an agent extension wrote in a content process (spike S6), as Electron notes it: from the extension
   * process, its own pages (`onglet` null); from a web process, a content script: the WebAiOs tab of a non-private space
   * it came from (else none), whose readability the noyau decides as it notes it (its policy, as Electron's
   * ongletLisibleParAgent). A web process is untrusted: the window must be one of its own, looked up here.
   */
  function relayConsole(from: { childID: number; remoteType: string }, data: unknown): void {
    const d = (data ?? {}) as { addonId?: unknown; niveau?: unknown; texte?: unknown; innerWindowID?: unknown };
    // Any installed agent add-on (its background runs before its grant is written): never an invented id.
    if (typeof d.addonId !== "string" || !d.addonId.endsWith(SUFFIX) || !WebExtensionPolicy.getByID(d.addonId)) return;
    if (typeof d.niveau !== "string" || typeof d.texte !== "string") return;
    let onglet: { ongletId: string | null; url: string } | null = null;
    if (from.remoteType === "extension" && d.niveau === "error") {
      // Its background window's error (or console.error): half of a load error, the parent's console has the other.
      const wgp = typeof d.innerWindowID === "number" ? WindowGlobalParent.getByInnerWindowId(d.innerWindowID) : null;
      const spec = wgp?.domProcess?.childID === from.childID && wgp.documentPrincipal?.addonId === d.addonId ? wgp.documentURI?.spec : null;
      if (typeof spec === "string" && new URL(spec).pathname === BACKGROUND_PAGE) crashes.backgroundError(d.addonId, String((d as { source?: unknown }).source ?? ""), d.texte);
    }
    if (from.remoteType !== "extension") {
      const wgp = typeof d.innerWindowID === "number" ? WindowGlobalParent.getByInnerWindowId(d.innerWindowID) : null;
      const browser = wgp?.domProcess?.childID === from.childID ? wgp.browsingContext.top.embedderElement : null;
      const t = ongletDe(browser?.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser));
      // The address of the page that wrote it, as the parent knows it: never a later one the tab moved to.
      const url = wgp?.topWindowContext?.documentURI?.spec;
      onglet = t && !t.espace.prive && typeof url === "string" ? { ongletId: t.onglet.id, url } : { ongletId: null, url: "" };
    }
    const m = { horodatage: Date.now(), niveau: niveauConsole(d.niveau === "warn" ? "warning" : d.niveau), texte: d.texte.slice(0, CONSOLE_TEXT_MAX) };
    host().notify("extensions.console", { addonId: d.addonId, m, onglet });
  }

  // The network guard beyond the copy's CSP, as Electron's equiperPagesAgent and more: every http(s) request an agent
  // extension loads or starts, of any type (navigation, window, a redirect of one, but also what Firefox's parent loads
  // for it, such as a notification icon, which no CSP sees), goes only where urlPermise says. Fail closed before the
  // grants arrive. Content scripts carry an expanded principal (no addonId): not concerned.
  Services.obs.addObserver((subject: any) => {
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    const info = channel.loadInfo;
    const addonId: string = info.loadingPrincipal?.addonId || info.triggeringPrincipal?.addonId || "";
    if (addonId.endsWith(SUFFIX) && !check(addonId, "urlPermise", channel.URI.spec)) channel.cancel(Cr.NS_BINDING_ABORTED);
  }, "http-on-modify-request");
  // Electron has none of these, and Firefox grants activeTab to an MV3 extension on a click of its button, its menu
  // item or its command even without the right (originControls): refused in the parent, for every page of the agent's
  // extensions (background, popup, tabs), before Firefox looks at the call.
  // The conduit bound its recv methods at startup: its APICall entry is the one to wrap.
  const api = ExtensionParent.ParentAPIManager;
  const recvAPICall = api.conduit.recv.get("APICall");
  api.conduit.recv.set("APICall", (data: { childId: number; callId?: number; path: string }, meta: unknown) => {
    if (REFUSED_CALLS.has(data.path) && api.getContextUnchecked(data.childId)?.extension?.id?.endsWith(SUFFIX)) {
      if (data.callId) api.conduit.sendCallResult(data.childId, { childId: data.childId, callId: data.callId, path: data.path, error: { message: `${data.path} non pris en charge par WebAiOs` } });
      return;
    }
    return recvAPICall(data, meta);
  });
  // runtime.setUninstallURL: Firefox opens it with a null principal when the add-on goes, so it is read through
  // urlPermise then (null: no tab). Hooked on each agent extension as it starts, and on those already running.
  // The parking tab is no tab for Electron: tabs.query, tabs.get, windows.getAll and the tab events never list it, even with the
  // tabs right. Nor a tab of a private space: Electron never loads an agent extension in a private profile's session.
  // canAccessTab is what Firefox's TabManager asks before it wraps any tab for the extension.
  const guardExtension = (extension: { id: string; uninstallURL: string | null; tabManager: { canAccessTab(tab: any): boolean } }) => {
    if (!extension?.id?.endsWith(SUFFIX)) return;
    const manager = extension.tabManager;
    const canAccess = manager.canAccessTab.bind(manager);
    manager.canAccessTab = (tab) => !tab.hasAttribute(PARKING) && !ongletDe(tab)?.espace.prive && canAccess(tab);
    let url = extension.uninstallURL;
    Object.defineProperty(extension, "uninstallURL", {
      get: () => (url && check(extension.id, "urlPermise", url) ? url : null),
      set: (v: string | null) => void (url = v),
      configurable: true,
    });
  };
  ExtensionParent.apiManager.on("startup", (_: string, extension: any) => guardExtension(extension));
  for (const policy of WebExtensionPolicy.getActiveExtensions()) if (policy.extension) guardExtension(policy.extension);

  // Crashes not acknowledged by a host: sent again with the next extensions.pret, at most PLANTAGES_MAX per extension.
  const crashesPending: { addonId: string; le: number }[] = [];
  const crashes = watchCrashes((addonId) => {
    const c = { addonId, le: Date.now() };
    crashesPending.push(c);
    const mine = crashesPending.filter((x) => x.addonId === addonId);
    if (mine.length > PLANTAGES_MAX) crashesPending.splice(crashesPending.indexOf(mine[0]!), 1);
    host()
      .request("extensions.plantage", c)
      .then(() => crashesPending.includes(c) && crashesPending.splice(crashesPending.indexOf(c), 1))
      .catch(() => {});
  });

  let settle = () => {};
  const ready = new Promise<void>((r) => (settle = r));
  return {
    handlers,
    ready,
    scopesKnown,
    check,
    relayConsole,
    hostStarted() {
      sendPrivate();
      const sent = [...pending].map(([addonId, quoi]) => ({ addonId, quoi }));
      const plantages = [...crashesPending];
      host()
        .request("extensions.pret", { horsWebaios: sent, plantages })
        .then(
          () => {
            sent.forEach((h) => pending.get(h.addonId) === h.quoi && pending.delete(h.addonId));
            for (const c of plantages) if (crashesPending.includes(c)) crashesPending.splice(crashesPending.indexOf(c), 1);
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
  const testWindow = Number(Services.env.get("WEBAIOS_TEST_WATCHDOG_MS"));
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
      return p ? Promise.resolve().then(() => p.getActor("WebAiOsConsole").sendQuery("ping")) : Promise.resolve();
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
