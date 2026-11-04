// Extension actor: on the agent's extension pages (background, popup, options), a frozen window.__webaios asks the
// parent, which reads the add-on id from the document's principal (never from the page) and answers from the grants.
// The console process actor relays the agent's extensions' console messages from every content process.
// Kept small: the build copies this file, so any change here needs a rebuild of the app (build:ui).
import type { WebAiOsStore } from "../store";
import type { CheckKind } from "../store/agent-extensions";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
// Keep in sync with noyau/extensions/copie-firefox.ts SUFFIXE_ID.
const SUFFIX = "@agent.webaios";
const KINDS: readonly string[] = ["urlPermise", "hotePermis", "estOnglet"] satisfies CheckKind[];

export class WebAiOsExtensionParent extends JSWindowActorParent {
  async receiveMessage(m: { name: string; data?: unknown }): Promise<boolean> {
    if (!KINDS.includes(m.name)) return false;
    const addonId: string = this.manager.documentPrincipal.addonId;
    const { agentExtensions } = (await ChromeUtils.importESModule(STORE).ready) as WebAiOsStore;
    await agentExtensions.scopesKnown();
    return agentExtensions.check(addonId, m.name as CheckKind, m.data);
  }
}

/** Neutralised in a frame that is not one of the extension's own documents (about:blank, srcdoc): Electron's frames have none. */
const FRAME_REMOVED = ["chrome", "browser", "RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"];

export class WebAiOsExtensionChild extends JSWindowActorChild {
  // DOMWindowCreated: before the page's first script (spike S5), and as an about:blank frame is created, before the
  // script that created it reads it.
  handleEvent() {
    const win = this.contentWindow as any;
    // Any page of an add-on with the agent's suffix; the parent answers false for one it did not grant.
    if (!(this.document as any).nodePrincipal.addonId?.endsWith(SUFFIX)) return;
    const api = Cu.createObjectIn(win);
    for (const kind of KINDS)
      Cu.exportFunction(
        (value: unknown) => {
          // Only a string or a number crosses: never a page object (getters, proxies).
          const v = typeof value === "string" || typeof value === "number" ? value : null;
          return new win.Promise((resolve: (b: boolean) => void) => this.sendQuery(kind, v).then((r) => resolve(r === true), () => resolve(false)));
        },
        api,
        { defineAs: kind },
      );
    Object.freeze(Cu.waiveXrays(api));
    Object.defineProperty(win.wrappedJSObject, "__webaios", { value: api, writable: false, configurable: false, enumerable: false });
    // As Electron's window-open handler: an agent page opens nothing itself (chrome.tabs.create, checked, does).
    Object.defineProperty(win.wrappedJSObject, "open", { value: Cu.exportFunction(() => null, win), writable: false, configurable: false, enumerable: true });
    // An about:blank or srcdoc frame inherits the extension's principal, and Firefox gives it the whole extension API
    // without the copy's guard: none of it, nor WebRTC. Non-configurable, so Firefox's later lazy getter cannot come
    // back either (a page of the extension loaded into that same window keeps none: a limit).
    if (!this.document.documentURI.startsWith("moz-extension:"))
      for (const name of FRAME_REMOVED) Object.defineProperty(win.wrappedJSObject, name, { value: undefined, writable: false, configurable: false, enumerable: false });
  }
}

/** The agent add-on a `moz-extension://<uuid>/…` file belongs to (a content script's ConsoleAPI addonId is empty: spike S6). */
function agentAddonOf(url: unknown): string | null {
  const host = /^moz-extension:\/\/([^/]+)\//.exec(String(url ?? ""))?.[1];
  const id = host ? (WebExtensionPolicy.getByHostname(host)?.id ?? null) : null;
  return id?.endsWith(SUFFIX) ? id : null;
}

/** As text only: nothing of the extension's objects is cloned out of its process. */
function textOf(args: unknown): string {
  return Array.from((args ?? []) as ArrayLike<unknown>, (a) => {
    try {
      return String(a);
    } catch {
      return "?";
    }
  }).join(" ");
}

/** The console relay's parent: what a content process relays goes to the store, which checks it (a web process is untrusted). */
export class WebAiOsConsoleParent extends JSProcessActorParent {
  async receiveMessage(m: { name: string; data?: unknown }): Promise<void> {
    if (m.name !== "console") return;
    const { agentExtensions } = (await ChromeUtils.importESModule(STORE).ready) as WebAiOsStore;
    agentExtensions.relayConsole(this.manager, m.data);
  }
}

/**
 * In every content process: the console messages (ConsoleAPI, and uncaught errors) of the agent's extensions — their
 * pages in the extension process, their content scripts in web processes — sent as text to the parent. Started by the
 * first document of the process (observer) or by the parent, once.
 */
export class WebAiOsConsoleChild extends JSProcessActorChild {
  private started = false;

  observe() {
    this.start();
  }

  receiveMessage() {
    this.start();
  }

  private start() {
    if (this.started) return;
    this.started = true;
    const send = (addonId: string | null, niveau: string, texte: string, source: unknown, innerWindowID: unknown) => {
      if (!addonId) return;
      try {
        this.sendAsyncMessage("console", { addonId, niveau, texte, source: String(source ?? ""), innerWindowID: Number(innerWindowID) || null });
      } catch {
        // The actor is gone (process shutting down).
      }
    };
    const onLog = (e: any) => send(e.addonId?.endsWith(SUFFIX) ? e.addonId : agentAddonOf(e.filename), String(e.level), textOf(e.arguments), e.filename, e.innerID);
    const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(Ci.nsIConsoleAPIStorage);
    // What the process logged before this started (its cache), then what comes.
    for (const e of storage.getEvents()) onLog(e);
    storage.addLogEventListener(onLog, Services.scriptSecurityManager.getSystemPrincipal());
    Services.console.registerListener({
      observe: (m: any) => {
        if (m instanceof Ci.nsIScriptError)
          send(agentAddonOf(m.sourceName), m.flags & Ci.nsIScriptError.warningFlag ? "warn" : "error", String(m.errorMessage), m.sourceName, m.innerWindowID);
      },
    });
  }
}
