// Site app actor: in every frame of an open site app's container, the child asks the parent
// what goes into its document; the parent decides from its own WindowGlobalParent (store/site-frames.ts), never from
// what the frame says. The CSS is put as an author sheet; the scripts run in an Xray sandbox per document, as Firefox
// runs an extension's content scripts: the sandbox sees the page's DOM through Xrays, neither the page's JS objects
// nor the chrome.
// Kept small: the build copies this file, so any change here needs a rebuild of the app (build:ui).
import type { RessacStore } from "../store";
import type { FrameInjection } from "../../shared/sites";
import type { MemoryResponse } from "../../core/sites/injection";
import { VIDEO_EVENTS, ResumeTracking } from "../../core/resume";

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
// Keep in sync with store/sites.ts SITE_FRAMES.
const SITE_FRAMES = "ressac-sites";
const OPS = ["remember", "read", "forget"] as const;
const UNAVAILABLE = "Mémoire de l'appli indisponible";
// Keep in sync with shared/sites.ts tweakSource.
const SOURCE = "ressac-tweak://";

/**
 * The tweaks' errors, seen in this content process (the parent's copy of a forwarded error has no window id): each
 * goes to the parent through its own window's actor, so the parent knows its frame from its WindowGlobalParent.
 * Started once per process, by the first document that runs tweaks.
 */
let listening = false;
function relayErrors(): void {
  if (listening) return;
  listening = true;
  Services.console.registerListener({
    observe(m: any) {
      if (!(m instanceof Ci.nsIScriptError) || !String(m.sourceName).startsWith(SOURCE) || !m.innerWindowID) return;
      try {
        WindowGlobalChild.getByInnerWindowId(m.innerWindowID)?.getActor("RessacSite").sendAsyncMessage("error", { text: String(m.errorMessage), source: String(m.sourceName), line: Number(m.lineNumber) || 0 });
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
export class RessacSiteParent extends JSWindowActorParent {
  async receiveMessage(m: { name: string; data?: unknown }): Promise<FrameInjection | MemoryResponse | number | null> {
    if (!["injection", "memory", "error", "position", "resume"].includes(m.name)) return null;
    const { sites } = (await ChromeUtils.importESModule(STORE).ready) as RessacStore;
    if (m.name === "injection") return sites.frameInjection(this.manager);
    if (m.name === "memory") return sites.frameMemory(this.manager, m.data);
    if (m.name === "resume") return sites.frameResume(this.manager, m.data);
    if (m.name === "position") sites.framePosition(this.manager, m.data);
    else sites.frameError(this.manager, m.data);
    return null;
  }
}

/** A reply of the expected shape, or null (nothing). */
function valid(r: unknown): FrameInjection | null {
  if (!r || typeof r !== "object") return null;
  const i = r as FrameInjection;
  return Array.isArray(i.css) && Array.isArray(i.js) && Array.isArray(i.hosts) ? i : null;
}

export class RessacSiteChild extends JSWindowActorChild {
  /** The scripts waiting for DOMContentLoaded. */
  private pending: (() => void) | null = null;
  private resumed = false;

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

  private apply(i: FrameInjection | null) {
    if (!i) return;
    const win = this.contentWindow as any;
    for (const css of i.css)
      try {
        win.windowUtils.loadSheetUsingURIString(`data:text/css;charset=utf-8,${encodeURIComponent(css)}`, win.windowUtils.AUTHOR_SHEET);
      } catch (e) {
        console.error("[ressac] CSS tweak not applied:", e);
      }
    if (i.resume === true) this.resume();
    if (i.js.length === 0 || typeof i.guard !== "string") return;
    const kept = i.guard;
    const doc = this.document as any;
    const sandbox = Cu.Sandbox(doc.nodePrincipal, { sandboxPrototype: win, wantXrays: true, wantComponents: false, sameZoneAs: win, sandboxName: "Ressac · tweaks" });
    // The page's own legacy `Components` shim (constants only) would show through the prototype: shadowed.
    Object.defineProperty(sandbox, "Components", { value: undefined });
    relayErrors();
    const innerWindowId: number = this.manager.innerWindowId;
    const run = (code: string, name: string): boolean => {
      try {
        Cu.evalInSandbox(code, sandbox, "latest", name, 1);
        return true;
      } catch (e: any) {
        // Reported with the script's own source and this window's id, so it reaches the tweaks' console (never
        // console.error, which would name this file). Cu.reportError would carry no window id from here.
        const err = Cc["@mozilla.org/scripterror;1"].createInstance(Ci.nsIScriptError);
        err.initWithWindowID(String(e), String(e?.fileName ?? name), Number(e?.lineNumber) || 0, Number(e?.columnNumber) || 0, Ci.nsIScriptError.errorFlag, "content javascript", innerWindowId);
        Services.console.logMessage(err);
        return false;
      }
    };
    // The guard first, alone: without it, none of the agent's scripts runs.
    if (!run(kept, "ressac-page-guard.js") || !run(`__ressacScope(${JSON.stringify({ network: [], hosts: i.hosts })})`, "ressac-scope.js")) return;
    if (i.bridge) this.bridge(sandbox);
    const scripts = () => {
      for (const { code, name: name } of i.js) run(code, name);
    };
    if (doc.readyState === "loading") this.pending = scripts;
    else scripts();
  }

  /**
   * In this actor's own world (neither the page's nor the sandbox's): the events of the
   * document's videos, captured. Only a trusted event counts (an event the page dispatches is ignored). The position
   * is set through the Xray view, so the page cannot hook it.
   */
  private resume() {
    // Once per window: an about:srcdoc frame keeps the inner window of its initial about:blank (the actor asked then, and not
    // again), so the listeners are on the window, which outlives the replaced document.
    if (this.resumed) return;
    this.resumed = true;
    const win = this.contentWindow as any;
    const tracking = new ResumeTracking({
      note: (t, duration, end) => this.sendAsyncMessage("position", { t, duration: duration, end: end }),
      ask: async (duration) => {
        try {
          const p: unknown = await this.sendQuery("resume", { duration: duration });
          return typeof p === "number" && Number.isFinite(p) ? p : null;
        } catch {
          return null;
        }
      },
      now: () => Date.now(),
    });
    for (const type of VIDEO_EVENTS)
      win.addEventListener(
        type,
        (e: any) => {
          const v = e.target;
          if (!e.isTrusted || !v || ChromeUtils.getClassName(v) !== "HTMLVideoElement") return;
          void tracking.onEvent(type, { currentTime: v.currentTime, duration: v.duration, key: v }).then((p) => {
            if (p !== null && p > 0) v.currentTime = p;
          });
        },
        { capture: true },
      );
  }

  /** `ressacSite` in the sandbox: promises of the sandbox, one request each; a refusal rejects with the memory's message. */
  private bridge(sandbox: any) {
    const api = Cu.createObjectIn(sandbox, { defineAs: "ressacSite" });
    for (const op of OPS)
      Cu.exportFunction(
        (key: unknown, value: unknown) =>
          new sandbox.Promise((resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
            let v: unknown;
            try {
              // A value the actor cannot copy (a function…): sent empty, the memory refuses it with its own message.
              v = op === "remember" ? Cu.cloneInto(Cu.waiveXrays(value), globalThis) : undefined;
            } catch {
              v = undefined;
            }
            const d = { op, key: typeof key === "string" ? key : null, ...(op === "remember" ? { value: v } : {}) };
            this.sendQuery("memory", d).then(
              (r: any) => {
                if (r?.ok === true) resolve(op === "read" ? Cu.cloneInto(r.value, sandbox) : undefined);
                else reject(new sandbox.Error(typeof r?.error === "string" ? r.error : UNAVAILABLE));
              },
              // Never asked again: the parent's error is not a value's.
              () => reject(new sandbox.Error(UNAVAILABLE)),
            );
          }),
        api,
        { defineAs: op },
      );
    Object.freeze(Cu.waiveXrays(api));
    // Tweaks written before the rename to Ressac call it by its old name.
    Object.defineProperty(sandbox, "webaiosSite", { value: api });
  }
}
