import { join } from "node:path";
import type { Decision, EtatAcces, IdProfil } from "../../../navigateur/src/commun/modele";
import { profilDOnglet, profilsEnUsage } from "../../../navigateur/src/commun/modele";
import { chargerSession, EnregistreurSession } from "../../../navigateur/src/main/etat/persistance";
import { bridgeHandlers, sendMirror, trackState } from "../agent/bridge";
import { createHost, HOST_EXITED, type AgentHost } from "../agent/host";
import { readHtml, readPage } from "../agent/invisible";
import { Questions } from "../agent/questions";
import type { OptionsLecturePage, PageLue } from "../shims/noyau";
import { registerWidgetProtocol } from "../window/widget-frame";
import { createAgentExtensions, type AgentExtensions } from "./agent-extensions";
import { createDownloads, type DownloadsList } from "./downloads";
import { createHistory, type History } from "./history";
import { registerAccueilNotifications } from "./notifications";
import { containerFor, existingContainer, migrateContainers, removeContainer } from "./containers";
import { registerPermissionHooks } from "./permission-hooks";
import { createSitePermissions, type SitePermission, type SitePermissions } from "./site-permissions";
import { createStore, type Store } from "./store";
import { createWindowRegistry, type WindowRegistry } from "./windows";
import { gardienGestes } from "../../shared/geste-widget";

const { AsyncShutdown } = ChromeUtils.importESModule("resource://gre/modules/AsyncShutdown.sys.mjs");
const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");

export interface WebAiOsStore extends Store {
  readonly dataDir: string;
  /** Where an unreadable session was set aside at startup, or null. */
  readonly setAside: string | null;
  flush(): Promise<void>;
  /** userContextId of a login profile: 0 for PROFIL_DEFAUT, an internal container otherwise (created on first use). */
  containerFor(profile: IdProfil): number;
  /** The Node host running the noyau, started with the store. */
  readonly agent: AgentHost;
  /** The noted visits, kept by the noyau host. */
  readonly history: History;
  /** The session's downloads, followed from Firefox's own list (not kept across a restart). */
  readonly downloads: DownloadsList;
  /** The agent's « lire l'onglet » cards waiting for an answer. */
  readonly questions: Questions;
  /** The WebAiOs windows open: each full browser window claims a window of the state. */
  readonly windows: WindowRegistry;
  /** What sites may do (notifications, position, camera, micro, MIDI, DRM, screen), asked once per profile and origin. */
  readonly sitePermissions: SitePermissions;
  /** The agent's extensions as Firefox add-ons, installed and switched as the noyau host says. */
  readonly agentExtensions: AgentExtensions;
  /** The agent's access to tabs, as the host last sent it (no access while no host runs). */
  readonly access: EtatAcces;
  /** The real clicks in a widget's display: each lets that widget open one link (recorded by the widget frame actor). */
  readonly gestesWidgets: ReturnType<typeof gardienGestes<string>>;
  /** Invisible page reads (the bridge's lirePageInvisible / lireHtmlInvisible), exposed for the e2e tests. */
  readPage(url: string, o: OptionsLecturePage, signal?: AbortSignal): Promise<PageLue>;
  readHtml(url: string, o: { adressesLocales?: boolean }, signal?: AbortSignal): Promise<{ url: string; html: string }>;
}

const PAGE_ACTOR = "chrome://browser/content/webaios/page-actor.sys.mjs";
const WIDGET_ACTOR = "chrome://browser/content/webaios/widget-actor.sys.mjs";

/**
 * The extension actor's module. Tests only: WEBAIOS_TEST_EXTENSION_ACTOR names a folder holding it, served by a
 * resource:// substitution (the content sandbox reads it only with security.sandbox.content.mac.testing_read_path1
 * set to that folder: spike S5), so the e2e run without a rebuild of the app.
 */
function extensionActorModule(): string {
  const dir = Services.env.get("WEBAIOS_TEST_EXTENSION_ACTOR");
  if (!dir) return "chrome://browser/content/webaios/extension-actor.sys.mjs";
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler).setSubstitution("webaios-test", Services.io.newFileURI(new FileUtils.File(dir)));
  return "resource://webaios-test/extension-actor.sys.mjs";
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

const principalOf = (profile: IdProfil, origin: string, create: boolean) => {
  const userContextId = create ? containerFor(profile) : existingContainer(profile);
  return userContextId === null ? null : Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(origin), userContextId ? { userContextId } : {});
};

/** Mirrors the decisions into Firefox's permission manager: without it a page reads "default" after an allow (spike P6). */
const firefoxPermissions = {
  set(profile: IdProfil, origin: string, p: SitePermission, d: Decision) {
    const principal = principalOf(profile, origin, true);
    for (const type of FIREFOX_TYPES[p] ?? []) Services.perms.addFromPrincipal(principal, type, d === "autoriser" ? Services.perms.ALLOW_ACTION : Services.perms.DENY_ACTION, Services.perms.EXPIRE_NEVER);
  },
  /** (null, null): every origin of every container. (profile, null): a whole container. (profile, origin): one origin. */
  remove(profile: IdProfil | null, origin: string | null) {
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

const dataDir =
  Services.env.get("WEBAIOS_DATA_DIR") || PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, "WebAiOs-firefox", "data");

const gestesWidgets = gardienGestes<string>();

async function start(): Promise<WebAiOsStore> {
  // Our history is the only one: Firefox's would grow unread. Set at runtime on the default branch, before any window
  // (favicons, back/forward and reopening a closed tab keep working: plan 24 spike S1).
  Services.prefs.getDefaultBranch("").setBoolPref("places.history.enabled", false);
  // A decision is per login profile: without this, one container's permission holds in all of them (spike P6).
  Services.prefs.getDefaultBranch("").setBoolPref("permissions.isolateBy.userContext", true);
  // DRM asks through our hook (without it all DRM is refused); sounds play without a click; no popup-blocked bar (spike P4, P8).
  Services.prefs.getDefaultBranch("").setBoolPref("media.eme.require-app-approval", true);
  Services.prefs.getDefaultBranch("").setIntPref("media.autoplay.default", 0);
  Services.prefs.getDefaultBranch("").setBoolPref("privacy.popups.showBrowserMessage", false);
  // Fullscreen is granted without a question and, as in Electron, without Firefox's warning over the page (spike P8).
  Services.prefs.getDefaultBranch("").setIntPref("full-screen-api.warning.timeout", 0);
  // Mozilla's update server offers Widevine (DRM) only to a Firefox version: under WebAiOs's own version it answers
  // with no module, and no DRM site ever plays.
  const gmp = Services.prefs.getDefaultBranch("").getCharPref("media.gmp-manager.url", "");
  if (gmp.includes("%VERSION%")) Services.prefs.getDefaultBranch("").setCharPref("media.gmp-manager.url", gmp.replace("%VERSION%", Services.appinfo.platformVersion));
  // The widgets' displays, before any window asks for one (the scheme exists in the parent process only).
  registerWidgetProtocol({ widgetsDir: join(dataDir, "espace", "accueil", "widgets") });
  migrateContainers();
  let setAside: string | null = null;
  const store = createStore(await chargerSession(dataDir, (p) => (setAside = p)));
  const questions = new Questions(store);
  const sitePermissions = createSitePermissions({
    dataDir,
    profiles: () => [...profilsEnUsage(store.state)],
    ask: (d, signal) => questions.askSite(d, signal),
    firefox: firefoxPermissions,
  });
  registerPermissionHooks({
    sitePermissions,
    tabOf: (browser) => {
      const win = browser.ownerDocument.defaultView;
      const ongletId = win?.gBrowser?.getTabForBrowser(browser)?.getAttribute("webaios-tab-id") ?? win?.webaiosPopupSource;
      const onglet = ongletId ? store.state.onglets[ongletId] : undefined;
      return onglet ? { ongletId, fenetreId: onglet.fenetreId, profil: profilDOnglet(store.state, onglet) } : null;
    },
    isInvisible: (browser) => browser.getAttribute("messagemanagergroup") === "webaios-reading",
  });
  const recorder = new EnregistreurSession(dataDir);
  const flush = () => recorder.vider();
  store.subscribe((state, previous) => {
    recorder.planifier(state);
    const used = profilsEnUsage(state);
    for (const id of profilsEnUsage(previous)) if (!used.has(id)) {
        try {
          void sitePermissions.removeProfile(id);
          removeContainer(id);
        } catch (e) {
          console.error("[store] container removal failed:", e);
        }
      }
  });
  AsyncShutdown.profileBeforeChange.addBlocker("WebAiOs: save the session", flush);
  ChromeUtils.registerWindowActor("WebAiOsPage", {
    parent: { esModuleURI: PAGE_ACTOR },
    child: { esModuleURI: PAGE_ACTOR },
    matches: ["http://*/*", "https://*/*", "file:///*"],
    // The child only reads and answers: nothing a compromised web process sends can make the parent act.
    safeForUntrustedWebProcess: true,
    messageManagerGroups: ["browsers", "webaios-reading"],
  });
  ChromeUtils.registerWindowActor("WebAiOsReading", {
    parent: { esModuleURI: PAGE_ACTOR },
    child: { esModuleURI: PAGE_ACTOR, events: { DOMWindowCreated: {} } },
    allFrames: true,
    // Only turns retargeting off in its own frame: nothing it answers makes the parent act.
    safeForUntrustedWebProcess: true,
    messageManagerGroups: ["webaios-reading"],
  });
  // The widget displays: a chrome subframe of the sidebar, in the parent process. No `matches`: no pattern catches
  // webaios-widget: (spike P3), so the child filters on the document's URL; being a subframe of a chrome document, it
  // also needs allFrames and includeChrome. Not marked safeForUntrustedWebProcess: it is then not created in web
  // content processes at all (dom.jsipc.check_safeForUntrustedWebProcess), and those can never host the scheme.
  ChromeUtils.registerWindowActor("WebAiOsWidget", {
    parent: { esModuleURI: WIDGET_ACTOR },
    child: { esModuleURI: WIDGET_ACTOR, events: { DOMWindowCreated: {} } },
    allFrames: true,
    includeChrome: true,
  });
  const extensionActor = extensionActorModule();
  // The agent's extension pages: background and popup (webext-browsers), options or pages in a tab (browsers). No
  // `matches`: the about:blank frames that inherit an agent page's principal must be reached too (the child filters
  // on the document's principal).
  ChromeUtils.registerWindowActor("WebAiOsExtension", {
    parent: { esModuleURI: extensionActor },
    child: { esModuleURI: extensionActor, events: { DOMWindowCreated: {} } },
    remoteTypes: ["extension"],
    messageManagerGroups: ["webext-browsers", "browsers"],
    allFrames: true,
  });
  // The agent's extensions' consoles, in every content process: a content script writes in a web process (spike S6).
  // What it relays is untrusted there: the parent checks it (agentExtensions.relayConsole).
  ChromeUtils.registerProcessActor("WebAiOsConsole", {
    parent: { esModuleURI: extensionActor },
    child: { esModuleURI: extensionActor, observers: ["content-document-global-created"] },
    safeForUntrustedWebProcess: true,
  });
  for (const p of ChromeUtils.getAllDOMProcesses())
    if (p.remoteType)
      try {
        p.getActor("WebAiOsConsole").sendAsyncMessage("start");
      } catch (e) {
        console.error("[extensions] console relay not started:", e);
      }
  let refreshMirror = () => {};
  const windows = createWindowRegistry({
    store,
    open: () => BrowserWindowTracker.openWindow(),
    // The window's agent session stops with it; its questions go to the active window, or are refused.
    onRelease: (fenetre) => {
      agent.notify("agent.fermerFenetre", { fenetre });
      questions.windowClosed(fenetre, windows.active());
      refreshMirror();
    },
    // The agent follows the focused window at once, as Electron reads it live.
    onActivate: () => refreshMirror(),
  });
  // The agent's access to tabs, as the host last sent it (no access while no host runs).
  let access: EtatAcces = { agent: "L'agent", onglets: {} };
  const agentExtensions = createAgentExtensions(store, windows, questions, () => agent, () => access);
  const agent = createHost({
    dataDir,
    profilAgent: () => store.state.reglages.profilAgent,
    handlers: { ...bridgeHandlers(store, questions, windows), ...agentExtensions.handlers },
    onStart: (notify) => {
      sendMirror(store, windows, notify);
      // A rendrePrive sent while no host ran was dropped: replayed (idempotent) so no private space stays searchable.
      for (const e of store.state.espaces) if (e.prive) notify("historique.rendrePrive", { espaceId: e.id });
      agentExtensions.hostStarted();
      // A restart (« Réessayer ») may have missed the home's changes: it reads again now that the host answers.
      notify("accueil.change");
    },
  });
  const history = createHistory(store, agent);
  registerAccueilNotifications(agent);
  const downloads = await createDownloads();
  refreshMirror = trackState(store, agent, windows);
  // Registered before any UI listener: the UI reads `access` once it is updated.
  agent.on("acces", (e: EtatAcces) => (access = e));
  agent.on(HOST_EXITED, () => (access = { agent: access.agent, onglets: {} }));
  agent.ensure().catch((e) => console.error("[agent] the noyau did not start:", e));
  // No `node … host.ts` may outlive the app: its sessions and MCP server stop with it.
  AsyncShutdown.profileBeforeChange.addBlocker("WebAiOs: stop the agent host", () => agent.stop());
  return {
    get state() {
      return store.state;
    },
    dispatch: store.dispatch,
    subscribe: store.subscribe,
    dataDir,
    setAside,
    flush,
    containerFor,
    agent,
    history,
    downloads,
    questions,
    windows,
    agentExtensions,
    sitePermissions,
    get access() {
      return access;
    },
    gestesWidgets,
    readPage: (url, o, signal) => readPage(store, url, o, signal),
    readHtml: (url, o, signal) => readHtml(store, url, o, signal),
  };
}

export const ready: Promise<WebAiOsStore> = start();
