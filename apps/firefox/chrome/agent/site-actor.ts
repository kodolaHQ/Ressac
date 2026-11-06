// Site app actor (Electron's preload/site.ts): in every frame of an open site app's container, the child asks the parent
// what goes into its document; the parent decides from its own WindowGlobalParent (store/site-frames.ts), never from
// what the frame says. The CSS is put as an author sheet; the scripts run in an Xray sandbox per document, as Firefox
// runs an extension's content scripts: the sandbox sees the page's DOM through Xrays, neither the page's JS objects
// nor the chrome.
// Kept small: the build copies this file, so any change here needs a rebuild of the app (build:ui).
import type { WebAiOsStore } from "../store";
import type { InjectionCadre } from "../../../navigateur/src/commun/sites";
import type { ReponseMemoire } from "../../../navigateur/src/main/sites/injection";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
// Keep in sync with store/sites.ts SITE_FRAMES.
const SITE_FRAMES = "webaios-sites";
const OPS = ["retenir", "lire", "oublier"] as const;
const UNAVAILABLE = "Mémoire de l'appli indisponible";
// Keep in sync with commun/sites.ts sourceRetouche.
const SOURCE = "webaios-retouche://";

/**
 * The retouches' errors, seen in this content process (the parent's copy of a forwarded error has no window id): each
 * goes to the parent through its own window's actor, so the parent knows its frame from its WindowGlobalParent.
 * Started once per process, by the first document that runs retouches.
 */
let listening = false;
function relayErrors(): void {
  if (listening) return;
  listening = true;
  Services.console.registerListener({
    observe(m: any) {
      if (!(m instanceof Ci.nsIScriptError) || !String(m.sourceName).startsWith(SOURCE) || !m.innerWindowID) return;
      try {
        WindowGlobalChild.getByInnerWindowId(m.innerWindowID)?.getActor("WebAiOsSite").sendAsyncMessage("erreur", { texte: String(m.errorMessage), source: String(m.sourceName), ligne: Number(m.lineNumber) || 0 });
      } catch {
        // The window or its actor is gone.
      }
    },
  });
}

/**
 * A web process is untrusted: only the message's name and the bounded fields of a memory request or an error are read; the
 * frame's address, place and view come from this actor's WindowGlobalParent.
 */
export class WebAiOsSiteParent extends JSWindowActorParent {
  async receiveMessage(m: { name: string; data?: unknown }): Promise<InjectionCadre | ReponseMemoire | null> {
    if (m.name !== "injection" && m.name !== "memoire" && m.name !== "erreur") return null;
    const { sites } = (await ChromeUtils.importESModule(STORE).ready) as WebAiOsStore;
    if (m.name === "injection") return sites.frameInjection(this.manager);
    if (m.name === "memoire") return sites.frameMemory(this.manager, m.data);
    sites.frameError(this.manager, m.data);
    return null;
  }
}

/** Electron's demander: a reply of the expected shape, or null (nothing). */
function valid(r: unknown): InjectionCadre | null {
  if (!r || typeof r !== "object") return null;
  const i = r as InjectionCadre;
  return Array.isArray(i.css) && Array.isArray(i.js) && Array.isArray(i.hotes) ? i : null;
}

export class WebAiOsSiteChild extends JSWindowActorChild {
  /** The scripts waiting for DOMContentLoaded. */
  private pending: (() => void) | null = null;

  // DOMWindowCreated: the request. DOMContentLoaded (capture, listened above the page's window): the scripts, even
  // when the page stops the event's propagation.
  handleEvent(e: Event) {
    if (e.target !== this.document || !e.isTrusted) return;
    if (e.type === "DOMContentLoaded") {
      const run = this.pending;
      this.pending = null;
      return run?.();
    }
    const doc = this.document as any;
    const all = Services.cpmm.sharedData.get(SITE_FRAMES) as Map<number, string> | null;
    if (!all?.has(doc.nodePrincipal.originAttributes.userContextId)) return;
    const uri: string = doc.documentURI;
    if (!/^https?:/.test(uri) && uri !== "about:blank" && uri !== "about:srcdoc") return;
    this.sendQuery("injection").then(
      (r) => this.apply(valid(r)),
      () => {},
    );
  }

  private apply(i: InjectionCadre | null) {
    if (!i) return;
    const win = this.contentWindow as any;
    for (const css of i.css)
      try {
        win.windowUtils.loadSheetUsingURIString(`data:text/css;charset=utf-8,${encodeURIComponent(css)}`, win.windowUtils.AUTHOR_SHEET);
      } catch (e) {
        console.error("[webaios] retouche CSS non posée :", e);
      }
    if (i.js.length === 0 || typeof i.garde !== "string") return;
    const garde = i.garde;
    const doc = this.document as any;
    const sandbox = Cu.Sandbox(doc.nodePrincipal, { sandboxPrototype: win, wantXrays: true, wantComponents: false, sameZoneAs: win, sandboxName: "WebAiOs · retouches" });
    // The page's own legacy `Components` shim (constants only) would show through the prototype: shadowed.
    Object.defineProperty(sandbox, "Components", { value: undefined });
    relayErrors();
    const innerWindowId: number = this.manager.innerWindowId;
    const run = (code: string, name: string): boolean => {
      try {
        Cu.evalInSandbox(code, sandbox, "latest", name, 1);
        return true;
      } catch (e: any) {
        // Reported with the script's own source and this window's id, so it reaches the retouches' console (never
        // console.error, which would name this file). Cu.reportError would carry no window id from here.
        const err = Cc["@mozilla.org/scripterror;1"].createInstance(Ci.nsIScriptError);
        err.initWithWindowID(String(e), String(e?.fileName ?? name), Number(e?.lineNumber) || 0, Number(e?.columnNumber) || 0, Ci.nsIScriptError.errorFlag, "content javascript", innerWindowId);
        Services.console.logMessage(err);
        return false;
      }
    };
    // The guard first, alone: without it, none of the agent's scripts runs.
    if (!run(garde, "webaios-garde-page.js") || !run(`__webaiosPortee(${JSON.stringify({ reseau: [], hotes: i.hotes })})`, "webaios-portee.js")) return;
    if (i.pont) this.bridge(sandbox);
    const scripts = () => {
      for (const { code, nom } of i.js) run(code, nom);
    };
    if (doc.readyState === "loading") this.pending = scripts;
    else scripts();
  }

  /** `webaiosSite` in the sandbox: promises of the sandbox, one request each; a refusal rejects with the memory's message. */
  private bridge(sandbox: any) {
    const api = Cu.createObjectIn(sandbox, { defineAs: "webaiosSite" });
    for (const op of OPS)
      Cu.exportFunction(
        (cle: unknown, valeur: unknown) =>
          new sandbox.Promise((resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            let v: unknown;
            try {
              // A value the actor cannot copy (a function…): sent empty, the memory refuses it with its own message.
              v = op === "retenir" ? Cu.cloneInto(Cu.waiveXrays(valeur), globalThis) : undefined;
            } catch {
              v = undefined;
            }
            const d = { op, cle: typeof cle === "string" ? cle : null, ...(op === "retenir" ? { valeur: v } : {}) };
            this.sendQuery("memoire", d).then(
              (r: any) => {
                if (r?.ok === true) resolve(op === "lire" ? Cu.cloneInto(r.valeur, sandbox) : undefined);
                else reject(new sandbox.Error(typeof r?.erreur === "string" ? r.erreur : UNAVAILABLE));
              },
              // Never asked again: the parent's error is not a value's.
              () => reject(new sandbox.Error(UNAVAILABLE)),
            );
          }),
        api,
        { defineAs: op },
      );
    Object.freeze(Cu.waiveXrays(api));
  }
}
