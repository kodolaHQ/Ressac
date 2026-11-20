import { shortcutLabel } from "../../shared/shortcuts";
import { DEFAULT_AURA } from "../../shared/aura";
import { keptLoaded, privateTab, tabProfile, profilesInUse, permissionProfiles, siteProfile, type BrowserState, type Tab, type Decision, type AccessState, type WindowId, type ProfileId, type Appearance } from "../../shared/model";
import type { ReportedError } from "../../shared/telemetry";
import type { Action } from "../../shared/api";
import { checkDataFormat } from "../../core/state/format";
import { lazySave, loadSession, SessionRecorder } from "../../core/state/persistence";
import { memorySession, withEssentials } from "../../core/state/actions";
import { bridgeHandlers, sendMirror, trackState } from "../agent/bridge";
import { createHost, HOST_EXITED, type AgentHost } from "../agent/host";
import { createAgentView, type AgentView } from "../agent/agent-view";
import { readHtml, readPage } from "../agent/invisible";
import { Questions } from "../agent/questions";
import type { PageReadOptions, ReadPage } from "../shims/kernel";
import { apps, bindApps, type AgentApps } from "./apps";
import { actionImage, releaseComponent, serveComponent } from "./action-media";
import { createAgentExtensions, type AgentExtensions } from "./agent-extensions";
import { createDesign, type DesignService } from "./design";
import { createOverlays } from "../window/design-overlays";
import { FRAMES_GROUP, FRAMES_TEST_KEY, framesKindDir, wipeFrames } from "../window/frames-root";
import * as remoteFrames from "../window/remote-frame";
import { neutralizeFirefoxWindow } from "../window/firefox-items";
import { createDevTools, type DevTools } from "./devtools";
import { createDownloads, type DownloadsList } from "./downloads";
import { createHistory, type History } from "./history";
import { createAsk, type Ask } from "./ask";
import { createBrowserImporter } from "./import/importer";
import type { BrowserImportApi } from "../../shared/api";
import { searchBookmarks } from "./bookmarks";
import { registerHomeNotifications } from "./notifications";
import { containerFor, existingContainer, isAppContainer, isSiteContainer, removeContainer } from "./containers";
import { installCallPlayer } from "./call-player";
import { registerPermissionHooks } from "./permission-hooks";
import { createSitePermissions, fileOf, parse as parseDecisions, type SitePermission, type SitePermissions } from "./site-permissions";
import { bindSites, relabelSiteWindows, sites, type SiteApps } from "./sites";
import { createStore, type Store } from "./store";
import { installUpdates } from "./updates";
import { installPreferencesCleanup } from "./preferences-cleanup";
import { installTelemetry } from "./telemetry";
import { createSettingsChrome, type SettingsChrome } from "./settings";
import { createWindowRegistry, type WindowRegistry } from "./windows";
import { installUiNetwork, isUiDocument, type UiNetworkState } from "./ui-network";
import { gestureGuard } from "../../shared/widget-gesture";
import { resolveLocale } from "../../shared/i18n";
import { isSmallMac, memoryPrefs } from "../../shared/settings";
import { keepLoadedHosts } from "../window/tabs";
import { testEnv } from "../test-env";

const { AsyncShutdown } = ChromeUtils.importESModule("resource://gre/modules/AsyncShutdown.sys.mjs");
const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
const { TabUnloader } = ChromeUtils.importESModule("moz-src:///browser/components/tabbrowser/TabUnloader.sys.mjs");
// TabUnloader reads browser.tabs.min_inactive_duration_before_unload once, at its import (before memoryPrefs applies):
// without an explicit floor, its unloads (the memory watcher's included, it calls this same object) read the live pref.
const PATCHED = Symbol.for("ressac.unloadFloor");
if (!TabUnloader[PATCHED]) {
  TabUnloader[PATCHED] = true;
  for (const name of ["unloadTabAsync", "unloadLeastRecentlyUsedTab"]) {
    const original = TabUnloader[name];
    TabUnloader[name] = function (this: unknown, floor?: number) {
      return original.call(this, floor ?? Services.prefs.getIntPref("browser.tabs.min_inactive_duration_before_unload"));
    };
  }
}

export interface RessacStore extends Store {
  readonly dataDir: string;
  /** Where an unreadable session was set aside at startup, or null. */
  readonly setAside: string | null;
  readonly dataSetAside: { backup: string; reason: "format" | "reset" } | null;
  /** Error reports go out (a DSN is set): the first window tells it once. */
  readonly telemetryActive: boolean;
  /** What the settings page asks of the chrome: telemetry, version, Finder, export folder, reset. */
  readonly settings: SettingsChrome;
  /** Bookmarks, history and passwords from another browser on this Mac, through the engine's migrators. */
  readonly browserImport: BrowserImportApi;
  /** Places bookmarks (imported or saved), http(s) only. */
  readonly bookmarks: { search(text: string, limit?: number): Promise<{ url: string; title: string }[]> };
  flush(): Promise<void>;
  /** userContextId of a login profile: 0 for DEFAULT_PROFILE, an internal container otherwise (created on first use). */
  containerFor(profile: ProfileId): number;
  /** The Node host running the kernel, started with the store. */
  readonly agent: AgentHost;
  /** The noted visits, kept by the kernel host. */
  readonly history: History;
  /** The ⌘T questions: quick history search, else the agent. */
  readonly ask: Ask;
  /** The session's downloads, followed from Firefox's own list (not kept across a restart). */
  readonly downloads: DownloadsList;
  /** The agent's « lire l'onglet » cards waiting for an answer. */
  readonly questions: Questions;
  /** The Ressac windows open: each full browser window claims a window of the state. */
  readonly windows: WindowRegistry;
  /** What sites may do (notifications, position, camera, micro, MIDI, DRM, screen), asked once per profile and origin. */
  readonly sitePermissions: SitePermissions;
  /** The agent's extensions as Firefox add-ons, installed and switched as the kernel host says. */
  readonly agentExtensions: AgentExtensions;
  /** The agent's access to tabs, as the host last sent it (no access while no host runs). */
  readonly access: AccessState;
  /** The tab the agent last acted on, and its thumbnails while someone watches. */
  readonly agentView: AgentView;
  /** The agent's dev tools on tabs, owned by the running kernel. */
  readonly devtools: DevTools;
  /** The site apps' windows (never Ressac windows), opened and closed as the host asks. */
  readonly sites: SiteApps;
  /** The agent apps' windows (never Ressac windows), opened and closed as the host asks. */
  readonly apps: AgentApps;
  /** The design mode of each main window's tab and agent app window (spec §5.4-5.5). */
  readonly design: DesignService;
  /** The real clicks in a widget's display: each lets that widget open one link (recorded by the UI's chrome listener). */
  readonly widgetGestures: ReturnType<typeof gestureGuard<string>>;
  /** Invisible page reads (the bridge's lirePageInvisible / lireHtmlInvisible), exposed for the e2e tests. */
  readPage(url: string, o: PageReadOptions, signal?: AbortSignal): Promise<ReadPage>;
  readHtml(url: string, o: { localAddresses?: boolean }, signal?: AbortSignal): Promise<{ url: string; html: string }>;
  /** An action page's result images (`data:`, or null) and agent components (a resource:// copy per page showing it). */
  readonly actionMedia: { image(url: string): Promise<string | null>; serve(name: string): Promise<string | null>; release(name: string): Promise<void> };
}

const PAGE_ACTOR = "chrome://browser/content/ressac/page-actor.sys.mjs";

/**
 * An actor's module (`extension-actor`, `site-actor`). Tests only: RESSAC_TEST_EXTENSION_ACTOR names a folder holding
 * both, served by a resource:// substitution (the content sandbox reads it only with
 * security.sandbox.content.mac.testing_read_path1 set to that folder: spike S5), so the e2e run without a rebuild of the app.
 */
function actorModule(name: string): string {
  const dir = testEnv("RESSAC_TEST_EXTENSION_ACTOR");
  if (!dir) return `chrome://browser/content/ressac/${name}.sys.mjs`;
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler).setSubstitution("ressac-test", Services.io.newFileURI(new FileUtils.File(dir)));
  return `resource://ressac-test/${name}.sys.mjs`;
}

/** Firefox's permission types behind each decision we mirror (what the page reads through Notification.permission, permissions.query, MIDI). */
const FIREFOX_TYPES: Partial<Record<SitePermission, string[]>> = {
  notifications: ["desktop-notification"],
  geolocation: ["geo"],
  "media-camera": ["camera"],
  "media-micro": ["microphone"],
  // The same question: asked once, answered for both.
  midi: ["midi", "midi-sysex"],
};
const MIRRORED = new Set(Object.values(FIREFOX_TYPES).flat());

const principalOf = (profile: ProfileId, origin: string, create: boolean) => {
  const userContextId = create ? containerFor(profile) : existingContainer(profile);
  return userContextId === null ? null : Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(origin), userContextId ? { userContextId } : {});
};

/** An essential's site may notify: Firefox's permission for its origin, in the tab's container (a site app has its own). */
function notifies(state: BrowserState, o: Tab): boolean {
  const url = state.essentials.find((f) => f.id === o.link?.id)?.url ?? o.url;
  const origin = URL.parse(url)?.origin;
  const principal = origin?.startsWith("http") ? principalOf(tabProfile(state, o), origin, false) : null;
  return !!principal && Services.perms.testExactPermissionFromPrincipal(principal, "desktop-notification") === Services.perms.ALLOW_ACTION;
}

/**
 * Each essential's tab with its `notifies` read again (keepsLoaded). Allowed while saving memory, a lazy one loads now
 * (unless the user chose otherwise); refused, it only becomes unloadable again.
 */
function notifyChanges(state: BrowserState): Action[] {
  return Object.values(state.tabs).flatMap((o): Action[] => {
    if (o.link?.type !== "essential") return [];
    const now = notifies(state, o);
    if (now === o.notifies) return [];
    // Only what now stays loaded: never one nothing keeps, nor one the user unloaded with the setting off.
    const load = now && o.unloaded && state.settings.saveMemory && keptLoaded(state, { ...o, notifies: true }, keepLoadedHosts);
    return [{ type: "updateTab", id: o.id, fields: { notifies: now, ...(load ? { unloaded: false } : {}) } }];
  });
}

/** Mirrors the decisions into Firefox's permission manager: without it a page reads "default" after an allow (spike P6). */
const firefoxPermissions = {
  set(profile: ProfileId, origin: string, p: SitePermission, d: Decision) {
    const principal = principalOf(profile, origin, true);
    for (const type of FIREFOX_TYPES[p] ?? []) Services.perms.addFromPrincipal(principal, type, d === "allow" ? Services.perms.ALLOW_ACTION : Services.perms.DENY_ACTION, Services.perms.EXPIRE_NEVER);
  },
  /** (null, null): every origin of every container. (profile, null): a whole container. (profile, origin): one origin. */
  remove(profile: ProfileId | null, origin: string | null) {
    if (profile === null) return MIRRORED.forEach((type) => Services.perms.removeByType(type));
    const id = existingContainer(profile);
    if (id === null) return;
    if (origin !== null) {
      const principal = principalOf(profile, origin, false);
      return MIRRORED.forEach((type) => Services.perms.removeFromPrincipal(principal, type));
    }
    for (const perm of Services.perms.all) if (MIRRORED.has(perm.type) && perm.principal.originAttributes.userContextId === id) Services.perms.removePermission(perm);
  },
};

// A dev or e2e build only: the packaged app keeps every trust file (grants, approvals) where no environment moves it.
const dataDir =
  (typeof __RESSAC_PACKAGED__ !== "undefined" && __RESSAC_PACKAGED__ === false && Services.env.get("RESSAC_DATA_DIR")) ||
  PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, "Ressac");

const widgetGestures = gestureGuard<string>();

let uiNetState: UiNetworkState;

async function start(): Promise<RessacStore> {
  // The UI's network net first, before any await: the windows read its state before they give their frames a src.
  uiNetState = installUiNetwork(testEnv("RESSAC_TEST_UI_NETWORK_FAIL") || null);
  // Before anything else can fail: its errors are reported.
  const telemetry = installTelemetry();
  // Before anything touches the data folder: an unknown format sets it aside (workspace/ stays).
  const dataSetAside = await checkDataFormat(dataDir).catch((e) => (console.error("[data] format check failed:", e), null));
  // Our history is the only one: Firefox's would grow unread. Set at runtime on the default branch, before any window
  // (favicons, back/forward and reopening a closed tab keep working: plan 24 spike S1).
  Services.prefs.getDefaultBranch("").setBoolPref("places.history.enabled", false);
  // A decision is per login profile: without this, one container's permission holds in all of them (spike P6).
  Services.prefs.getDefaultBranch("").setBoolPref("permissions.isolateBy.userContext", true);
  // DRM asks through our hook (without it all DRM is refused); sounds play without a click; no popup-blocked bar (spike P4, P8).
  Services.prefs.getDefaultBranch("").setBoolPref("media.eme.require-app-approval", true);
  Services.prefs.getDefaultBranch("").setIntPref("media.autoplay.default", 0);
  Services.prefs.getDefaultBranch("").setBoolPref("privacy.popups.showBrowserMessage", false);
  // Fullscreen is granted without a question (spike P8); Firefox's warning over the page stays, for 1.5 s, so a page
  // painting a fake Ressac or a fake sign-in once fullscreen is still named.
  Services.prefs.getDefaultBranch("").setIntPref("full-screen-api.warning.timeout", 1500);
  // The browser's advanced settings without what contradicts Ressac.
  installPreferencesCleanup();
  // Mozilla's update server offers Widevine (DRM) only to a Firefox version: under Ressac's own version it answers
  // with no module, and no DRM site ever plays.
  const gmp = Services.prefs.getDefaultBranch("").getCharPref("media.gmp-manager.url", "");
  if (gmp.includes("%VERSION%")) Services.prefs.getDefaultBranch("").setCharPref("media.gmp-manager.url", gmp.replace("%VERSION%", Services.appinfo.platformVersion));
  // Sites that sniff the user agent (WhatsApp Web) take the trailing « Ressac/<version> » token for an old Firefox
  // and refuse to load: sites get the exact Firefox user agent of this engine.
  const http = Cc["@mozilla.org/network/protocol;1?name=http"].getService(Ci.nsIHttpProtocolHandler);
  Services.prefs.getDefaultBranch("").setCharPref("general.useragent.override", http.userAgent.replace(/ Ressac\/\S+/, ""));
  // The frames' copies (widgets, site homes, components) are a disposable cache: wiped at startup, so none made by an
  // older sanitizer (CSP_WIDGET, containsNetworkHint) is served. Before any copy is served.
  await wipeFrames().catch((e) => console.warn("[frames] copies not erased:", e));
  // Where older versions kept them.
  for (const old of ["ressac-widgets", "ressac-sites", "ressac-components"]) await IOUtils.remove(PathUtils.join(dataDir, old), { recursive: true, ignoreAbsent: true }).catch((e) => console.warn("[frames] old copies not erased:", e));
  let setAside: string | null = null;
  const smallMac = isSmallMac(Services.sysinfo.getProperty("memsize"), testEnv("RESSAC_TEST_SMALL_MAC"));
  const store = createStore(await loadSession(dataDir, (p) => (setAside = p)).then((s) => {
    const skip = Services.env.get("RESSAC_SKIP_WELCOME") === "1";
    const aiOff = testEnv("RESSAC_TEST_AI") === "0";
    // A test launch skips the welcome: AI on for a fresh profile unless the test asks for it off.
    const aiEnabled = aiOff ? false : skip && !s.settings.onboarded ? true : s.settings.aiEnabled;
    return skip ? { ...s, settings: { ...s.settings, onboarded: true, aiEnabled, seenVersion: s.settings.seenVersion ?? __RESSAC_VERSION__ } } : s;
  }).then((s) => withEssentials(s)).then(async (s) => {
    // Before the launch's lazy essentials: one allowed to notify (a messaging site) stays loaded. Read from Ressac's own
    // decisions: Firefox's copy is emptied and rebuilt from them just after, and a site app's container may be new.
    const draft = structuredClone(s);
    const decisions = new Map<string, Record<string, string> | null>();
    for (const o of Object.values(draft.tabs)) {
      if (o.link?.type !== "essential") continue;
      const profile = tabProfile(draft, o);
      if (!decisions.has(profile)) decisions.set(profile, await IOUtils.readUTF8(fileOf(dataDir, profile)).then(parseDecisions, () => null));
      const origin = URL.parse(draft.essentials.find((f) => f.id === o.link!.id)?.url ?? o.url)?.origin;
      o.notifies = decisions.get(profile)?.[`${origin} notifications`] === "allow";
    }
    return memorySession(draft, smallMac, keepLoadedHosts);
  }));
  // Later essentials' tabs, and the notification permission given or taken back: kept loaded or not, live.
  const refreshNotifies = () => notifyChanges(store.state).forEach((a) => store.dispatch(a));
  store.subscribe((s) => Object.values(s.tabs).some((o) => o.link?.type === "essential" && o.notifies === undefined) && queueMicrotask(refreshNotifies));
  // Any permission change (a few essentials, each read in a lookup): only real changes dispatch.
  Services.obs.addObserver(refreshNotifies, "perm-changed");
  // « Économiser la mémoire »: its Firefox prefs (memoryPrefs), applied live (Firefox rereads them).
  const applyMemoryPrefs = () => {
    for (const [name, value] of Object.entries(memoryPrefs(store.state.settings.saveMemory))) Services.prefs.getDefaultBranch("").setIntPref(name, value);
  };
  applyMemoryPrefs();
  store.subscribe((s, p) => s.settings.saveMemory !== p.settings.saveMemory && applyMemoryPrefs());
  const questions = new Questions(store, () => sites.forAgent(), () => apps.forAgent());
  // A site app or agent app window closed: the agent's questions on it fall.
  sites.onClosed(() => questions.dropStale());
  apps.onClosed(() => questions.dropStale());
  const sitePermissions = createSitePermissions({
    dataDir,
    profiles: () => [...permissionProfiles(store.state)],
    ask: (d, signal) => questions.askSite(d, signal),
    firefox: firefoxPermissions,
  });
  registerPermissionHooks({
    sitePermissions,
    tabOf: (browser) => {
      const win = browser.ownerDocument.defaultView;
      const tabId = win?.gBrowser?.getTabForBrowser(browser)?.getAttribute("ressac-tab-id") ?? win?.ressacPopupSource;
      const tab = tabId ? store.state.tabs[tabId] : undefined;
      return tab ? { tabId: tabId, windowId: tab.windowId, profile: tabProfile(store.state, tab) } : null;
    },
    isInvisible: (browser) => browser.getAttribute("messagemanagergroup") === "ressac-reading",
  });
  const recorder = new SessionRecorder(dataDir);
  const flush = () => recorder.clear();
  store.subscribe((state, previous, action) => {
    recorder.schedule(state, lazySave(action));
    // A deleted app's permissions go with it (sites.erase dispatches this before it wipes the container).
    if (action?.type === "forgetSite") void sitePermissions.removeProfile(siteProfile(action.id));
    const used = profilesInUse(state);
    for (const id of profilesInUse(previous)) if (!used.has(id)) {
        try {
          void sitePermissions.removeProfile(id);
          removeContainer(id);
        } catch (e) {
          console.error("[store] container removal failed:", e);
        }
      }
  });
  // After the recorder subscribed: the version seen is saved even if nothing else changes.
  store.dispatch({ type: "noteVersion", version: __RESSAC_VERSION__ });
  const updates = installUpdates(store.dispatch, telemetry.report);
  // The language shown: the setting, « system » resolved against the Mac's languages (read again on each change).
  const showLocale = () => {
    let system: string[] = [];
    try {
      const test = testEnv("RESSAC_TEST_MAC_LANGUAGES");
      system = test ? test.split(",") : Cc["@mozilla.org/intl/ospreferences;1"].getService(Ci.mozIOSPreferences).systemLocales;
    } catch (e) {
      // Never worth a broken start: without the Mac's languages, « system » shows English.
      console.error("[store] the Mac's languages are unreadable:", e);
    }
    const locale = resolveLocale(store.state.settings.language, system);
    store.dispatch({ type: "setLocale", locale });
    // Firefox's own menus and pages follow (its build packs Mozilla's translations, scripts/locales.sh); some only at the next launch.
    Services.locale.requestedLocales = [locale];
  };
  showLocale();
  store.subscribe((s, p) => s.settings.language !== p.settings.language && showLocale());
  AsyncShutdown.profileBeforeChange.addBlocker("Ressac: save the session", flush);
  ChromeUtils.registerWindowActor("RessacPage", {
    parent: { esModuleURI: PAGE_ACTOR },
    child: { esModuleURI: PAGE_ACTOR },
    matches: ["http://*/*", "https://*/*", "file:///*"],
    // The child only reads and answers: nothing a compromised web process sends can make the parent act.
    safeForUntrustedWebProcess: true,
    messageManagerGroups: ["browsers", "ressac-reading"],
  });
  ChromeUtils.registerWindowActor("RessacReading", {
    parent: { esModuleURI: PAGE_ACTOR },
    child: { esModuleURI: PAGE_ACTOR, events: { DOMWindowCreated: {} } },
    allFrames: true,
    // Only turns retargeting off in its own frame: nothing it answers makes the parent act.
    safeForUntrustedWebProcess: true,
    messageManagerGroups: ["ressac-reading"],
  });
  const extensionActor = actorModule("extension-actor");
  // The agent's extension pages: background and popup (webext-browsers), options or pages in a tab (browsers). No
  // `matches`: the about:blank frames that inherit an agent page's principal must be reached too (the child filters
  // on the document's principal).
  ChromeUtils.registerWindowActor("RessacExtension", {
    parent: { esModuleURI: extensionActor },
    child: { esModuleURI: extensionActor, events: { DOMWindowCreated: {} } },
    remoteTypes: ["extension"],
    messageManagerGroups: ["webext-browsers", "browsers"],
    allFrames: true,
  });
  // Site apps: every frame of a tab browser, about:blank and srcdoc ones too (no `matches`); the child asks only in an
  // open app's container, for an http(s), about:blank or about:srcdoc document.
  const siteActor = actorModule("site-actor");
  ChromeUtils.registerWindowActor("RessacSite", {
    parent: { esModuleURI: siteActor },
    child: { esModuleURI: siteActor, events: { DOMWindowCreated: {}, DOMContentLoaded: { capture: true } } },
    allFrames: true,
    messageManagerGroups: ["browsers"],
    // Required in web processes. The parent reads only the message's name and the bounded fields of a memory request
    // or an error: what it decides comes from its WindowGlobalParent (store/site-frames.ts).
    safeForUntrustedWebProcess: true,
  });
  // The design mode's viewfinder (design-actor.ts): every http(s) frame, so the guard reaches a frame of another process.
  // Only on the parent's demand (no events); the parent has no receiveMessage, so a web process cannot make it act.
  const designActor = actorModule("design-actor");
  ChromeUtils.registerWindowActor("RessacDesign", {
    parent: { esModuleURI: designActor },
    child: { esModuleURI: designActor },
    matches: ["http://*/*", "https://*/*"],
    allFrames: true,
    messageManagerGroups: ["browsers"],
    safeForUntrustedWebProcess: true,
  });
  // The same viewfinder on a site app's home (a remote frame): its top document only, armed on the copy the parent names.
  ChromeUtils.registerWindowActor("RessacDesignFrames", {
    parent: { esModuleURI: designActor },
    child: { esModuleURI: designActor },
    messageManagerGroups: [FRAMES_GROUP],
    safeForUntrustedWebProcess: true,
  });
  // The agent-written frames (frame-actor.ts): the top document of each remote frame <browser> only (no allFrames, no
  // matches). The child forwards a few bounded messages; the parent only looks up the frame owner's callback.
  const frameActor = actorModule("frame-actor");
  remoteFrames.setFrameActor(frameActor);
  ChromeUtils.registerWindowActor("RessacFrame", {
    parent: { esModuleURI: frameActor },
    child: { esModuleURI: frameActor, events: { DOMWindowCreated: {}, DOMContentLoaded: { capture: true } } },
    messageManagerGroups: [FRAMES_GROUP],
    safeForUntrustedWebProcess: true,
  });
  // The frames' test hook is on only in a dev build with RESSAC_TEST_FRAMES: a flag the web process reads, a page cannot set.
  if (testEnv("RESSAC_TEST_FRAMES")) {
    Services.ppmm.sharedData.set(FRAMES_TEST_KEY, true);
    Services.ppmm.sharedData.flush();
  }
  // Calls (call-actor.ts): every http(s) frame, a call's video may sit in one. The child acts on the parent's demand;
  // the parent only relays a call's state (two booleans) to the window of its own tab.
  const callActor = actorModule("call-actor");
  ChromeUtils.registerWindowActor("RessacCall", {
    parent: { esModuleURI: callActor },
    child: { esModuleURI: callActor },
    matches: ["http://*/*", "https://*/*"],
    allFrames: true,
    messageManagerGroups: ["browsers"],
    safeForUntrustedWebProcess: true,
  });
  installCallPlayer();
  // Windows with Firefox's menu bar that are not Ressac's (browser.xhtml windows do this in window/index.ts): the hidden
  // one, whose menu bar macOS shows with no window open, and Page Info, the Library, Firefox's About…
  const hidden = Services.appShell.hiddenDOMWindow;
  const hiddenMenus = (tries = 50) => {
    if (hidden.document.getElementById("main-menubar")) neutralizeFirefoxWindow(hidden);
    else if (tries > 0) setTimeout(() => hiddenMenus(tries - 1), 200);
  };
  hiddenMenus();
  Services.ww.registerNotification((subject: unknown, topic: string) => {
    if (topic !== "domwindowopened") return;
    const win = subject as unknown as Window;
    win.addEventListener(
      "DOMContentLoaded",
      () => {
        if (win.document.documentURI !== "chrome://browser/content/browser.xhtml" && win.document.getElementById("main-menubar")) neutralizeFirefoxWindow(win);
      },
      { once: true },
    );
  });
  // The vim mode (vim-actor.ts): top http(s) documents of tab browsers; the parent decides whether keys are taken there.
  // Registered only while the setting is on: off, no page pays for it. Unregistering destroys the actors (didDestroy
  // drops their listeners and layer); registering reaches the pages already open through `tell`.
  const vimActor = actorModule("vim-actor");
  const setVimActor = (on: boolean) => {
    if (!on) return ChromeUtils.unregisterWindowActor("RessacVim");
    ChromeUtils.registerWindowActor("RessacVim", {
      parent: { esModuleURI: vimActor },
      child: { esModuleURI: vimActor, events: { DOMWindowCreated: {}, pageshow: {} } },
      matches: ["http://*/*", "https://*/*"],
      messageManagerGroups: ["browsers"],
      safeForUntrustedWebProcess: true,
    });
    tellVimPages();
  };
  const tellVimPages = () => {
    for (const win of Services.wm.getEnumerator("navigator:browser"))
      for (const b of win.gBrowser?.browsers ?? [])
        if (/^https?:/.test(b.currentURI?.spec ?? ""))
          try {
            b.browsingContext?.currentWindowGlobal?.getActor("RessacVim").tell();
          } catch (e) {
            console.error("[vim] mode not sent:", e);
          }
  };
  // Appearance: the look-and-feel override that the chrome, our frames and the web pages (prefers-color-scheme) follow.
  const showAppearance = (a: Appearance) =>
    a === "system" ? Services.prefs.clearUserPref("ui.systemUsesDarkTheme") : Services.prefs.setIntPref("ui.systemUsesDarkTheme", a === "dark" ? 1 : 0);
  // « system » at launch leaves the pref alone (a test's own override; ours was cleared when the setting changed).
  if (store.state.settings.appearance !== "system") showAppearance(store.state.settings.appearance);
  store.subscribe((s, p) => s.settings.appearance !== p.settings.appearance && showAppearance(s.settings.appearance));
  if (store.state.settings.vimMode) setVimActor(true);
  store.subscribe((s, p) => {
    if (s.settings.vimMode !== p.settings.vimMode) setVimActor(s.settings.vimMode);
    // The pause pill and the `?` sheet follow the language.
    else if (s.settings.vimMode && s.locale !== p.locale) tellVimPages();
  });
  // The agent's extensions' consoles, in every content process: a content script writes in a web process (spike S6).
  // What it relays is untrusted there: the parent checks it (agentExtensions.relayConsole).
  ChromeUtils.registerProcessActor("RessacConsole", {
    parent: { esModuleURI: extensionActor },
    child: { esModuleURI: extensionActor, observers: ["content-document-global-created"] },
    safeForUntrustedWebProcess: true,
  });
  for (const p of ChromeUtils.getAllDOMProcesses())
    if (p.remoteType)
      try {
        p.getActor("RessacConsole").sendAsyncMessage("start");
      } catch (e) {
        console.error("[extensions] console relay not started:", e);
      }
  let refreshMirror = () => {};
  const windows = createWindowRegistry({
    store,
    open: () => BrowserWindowTracker.openWindow(),
    // The window's agent session stops with it; its questions go to the active window, or are refused.
    onRelease: (win) => {
      agent.notify("agent.closeWindow", { window: win });
      // Its id comes back if it was the last window (kept): no overlay or cart context stays for it.
      design.forget({ type: "window", windowId: win });
      questions.windowClosed(win, windows.active());
      refreshMirror();
    },
    // The agent follows the focused window at once.
    onActivate: () => refreshMirror(),
  });
  // The agent's access to tabs, as the host last sent it (no access while no host runs).
  let access: AccessState = { agent: "L'agent", tabs: {} };
  const agentExtensions = createAgentExtensions(store, windows, questions, () => agent, () => access);
  const devtools = createDevTools({
    store,
    windows,
    sites,
    apps,
    isPrivate: (id) => {
      const o = store.state.tabs[id];
      return !!o && privateTab(store.state, o);
    },
  });
  // The last main window; with none open, one opens first.
  async function mainWindow(): Promise<WindowId | undefined> {
    if (!windows.active()) {
      const win = BrowserWindowTracker.openWindow();
      await new Promise<void>((ok) => {
        const o = {
          observe(subject: unknown) {
            if (subject !== win) return;
            Services.obs.removeObserver(o, "browser-delayed-startup-finished");
            // After window/index.ts's claim, which follows the same delayed startup.
            Services.tm.dispatchToMainThread(() => ok());
          },
        };
        Services.obs.addObserver(o, "browser-delayed-startup-finished");
      });
    }
    return windows.active();
  }
  const toFront = (windowId: WindowId) => {
    const win = windows.get(windowId)?.window;
    if (!win) return;
    if (win.windowState === win.STATE_MINIMIZED) (win as any).restore();
    win.focus();
  };
  // The agent's panel with the keyboard, its window in front.
  const giveAgent = (win: WindowId) => {
    windows.get(win)?.controller.openAgent();
    toFront(win);
  };
  const agent = createHost({
    dataDir,
    agentProfile: () => store.state.settings.agentProfile,
    locale: () => store.state.locale,
    aiEnabled: () => store.state.settings.aiEnabled,
    handlers: {
      ...bridgeHandlers(store, questions, windows, devtools, () => agent, sites, apps),
      ...agentExtensions.handlers,
      ...sites.handlers,
      ...apps.handlers,
      "bookmarks.search": ([text, limit]: [string, number]) => searchBookmarks(text, limit),
      // A review batch for the agent (host/design.ts): its window, then its panel with the keyboard, in front.
      "design.agentWindow": async () => (await mainWindow()) ?? null,
      "design.giveAgent": ([win]: [WindowId]) => giveAgent(win),
    },
    onStart: (notify) => {
      sendMirror(store, windows, notify);
      notify("agent.codexEngine", { engine: store.state.settings.codexEngine });
      notify("agent.claudeEngine", { engine: store.state.settings.claudeEngine });
      notify("agent.mode", { mode: store.state.settings.agentMode });
      notify("settings.locale", { locale: store.state.locale });
      notify("settings.agentDomains", { domains: store.state.settings.agentDomains });
      notify("settings.machineIdle", { minutes: store.state.settings.machineIdleMinutes });
      notify("settings.saveMemory", { on: store.state.settings.saveMemory });
      notify("settings.localJudge", { on: store.state.settings.localJudge });
      // A rendrePrive sent while no host ran was dropped: replayed (idempotent) so no private space stays searchable.
      for (const e of store.state.spaces) if (e.private) notify("history.makePrivate", { spaceId: e.id });
      agentExtensions.hostStarted();
      // Its sites handlers are up: the host asks which app windows are open (sites.ouvertes).
      notify("sites.ready");
      // A respawned host lost the app essentials' tabs: they are read again.
      sites.reattachTabs();
    },
    onUnexpectedExit: (code) => telemetry.report({ source: "host", type: "HostExit", message: `exit code ${code}` }),
  });
  // « Ouvrir dans un onglet » of a site app: a tab of the last main window, in its active space, brought to the front
  // (« Ouvrir dans un onglet »); with no main window open, one opens first.
  // An agent app's link off its origin too.
  const openInTab = async (url: string) => {
    if (!/^https?:\/\//.test(url)) return;
    const windowId = await mainWindow();
    if (!windowId) return;
    store.dispatch({ type: "openTab", windowId: windowId, url });
    toFront(windowId);
  };
  const design = createDesign({ agent, windows, apps, sites, dispatch: store.dispatch, mainWindow, toFront, shortcutLabel: () => shortcutLabel("design", store.state.settings), locale: () => store.state.locale, aiOn: () => store.state.settings.aiEnabled, giveAgent });
  bindSites(agent, dataDir, openInTab, design, () => store.state.locale, () => {
    const s = store.state, w = s.windows.find((x) => x.id === windows.active());
    return s.spaces.find((x) => x.id === w?.activeSpace)?.aura ?? DEFAULT_AURA;
  }, store.dispatch);
  design.overlays = createOverlays({ design, host: agent });
  // A remapped design shortcut: the windows re-read the label (a site app's « Mode design (⇧⌘D) » tooltip).
  store.subscribe((s, p) => {
    if (shortcutLabel("design", s.settings) !== shortcutLabel("design", p.settings) || s.locale !== p.locale) design.refresh();
    if (s.locale !== p.locale) relabelSiteWindows();
    if (p.settings.aiEnabled && !s.settings.aiEnabled) void design.stopAll();
  });
  bindApps(agent, openInTab, dataDir, { access: () => access, design, locale: () => store.state.locale });
  const history = createHistory(store, agent);
  const ask = createAsk(agent, giveAgent);
  registerHomeNotifications(agent);
  // A site app's or an agent app's downloads are cancelled: an app downloads nothing (an agent app would drop files in ~/Downloads unasked).
  const downloads = await createDownloads((id) => isSiteContainer(id) || isAppContainer(id));
  refreshMirror = trackState(store, agent, windows);
  // macOS runs short of memory (browser.lowMemoryResponseMask, ressac.js): the host unloads the models and stops an unused machine.
  // Once as it starts: « low-memory-ongoing » repeats every 10 s while it lasts, and would kill a model the user just reloaded.
  Services.obs.addObserver((_s: unknown, _t: string, data: string) => data !== "low-memory-ongoing" && agent.notify("memory.pressure"), "memory-pressure");
  // Critical macOS pressure while saving memory (the host checks every 10 s): the least recently used eligible tab
  // unloads now, without the inactivity floor; Firefox's rules and our undiscardable flag still spare the rest.
  agent.on("memory.critical", () => void TabUnloader.unloadTabAsync(0));
  // Registered before any UI listener: the UI reads `access` once it is updated.
  agent.on("access", (e: AccessState) => (access = e));
  agent.on("telemetryError", (e: ReportedError) => telemetry.report({ ...e, source: "host" }));
  agent.on(HOST_EXITED, () => {
    access = { agent: access.agent, tabs: {} };
    // Its kernel is gone: nothing stays attached for it, and its apps' windows close (its successor stops the orphans).
    devtools.release();
    apps.closeAll();
  });
  // After the `access` listener above: it reads the access just received.
  const agentView = createAgentView({ store, host: agent, access: () => access, windows });
  agent.ensure().catch((e) => console.error("[agent] the kernel did not start:", e));
  // No `node … host.ts` may outlive the app: its sessions and MCP server stop with it.
  AsyncShutdown.profileBeforeChange.addBlocker("Ressac: stop the agent host", () => agent.stop());
  return {
    get state() {
      return store.state;
    },
    dispatch: store.dispatch,
    subscribe: store.subscribe,
    dataDir,
    setAside,
    dataSetAside,
    telemetryActive: telemetry.active,
    settings: createSettingsChrome(dataDir, telemetry.active, updates),
    browserImport: createBrowserImporter(dataDir, agent, store),
    bookmarks: { search: searchBookmarks },
    flush,
    containerFor,
    agent,
    history,
    ask,
    downloads,
    questions,
    windows,
    agentExtensions,
    sitePermissions,
    devtools,
    sites,
    apps,
    design,
    get access() {
      return access;
    },
    agentView,
    widgetGestures: widgetGestures,
    readPage: (url, o, signal) => readPage(store, url, o, signal),
    readHtml: (url, o, signal) => readHtml(store, url, o, signal),
    actionMedia: { image: actionImage, serve: (name) => serveComponent(dataDir, name, (name, token) => agent.request<number | null>("actions.copyComponent", { root: framesKindDir("components"), name, token })), release: (name) => releaseComponent(dataDir, name) },
  };
}

export const ready: Promise<RessacStore> = start();
// Site app windows: read synchronously by a window as it loads (chrome/window/site-window.ts).
export { sites, publishSiteFrames } from "./sites";
// Agent app windows: read synchronously by a window as it loads (chrome/window/app-window.ts).
export { apps } from "./apps";
// The UI's network net: read synchronously by a window before it gives its UI frames a src.
export const uiNetwork: { state(): UiNetworkState; isUiDocument(doc: Document | null | undefined): boolean } = { state: () => uiNetState, isUiDocument };
// For the e2e: the action images' channel, measured directly (plan 33 spike S2).
export { containerRequests, loadImage } from "./site-home";
// The UI's copy of frames-root.ts reads the store's token (one per launch).
export { framesToken } from "../window/frames-root";
// One copy for every window: the frames' group id and the actor's registry are per launch (ui/RemoteFrame.svelte).
export { remoteFrames };
export { actionImagesContainer } from "./action-media";
// For the e2e: test mode writes notifications to a file, so no alert is ever shown to click.
export { alertObserver } from "./notifications";
