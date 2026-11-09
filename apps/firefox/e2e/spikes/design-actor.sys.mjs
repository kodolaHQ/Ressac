// Throwaway actor of plan 35's spike (docs/superpowers/notes/2026-11-06-mode-design-firefox-spikes.md). Registered at
// runtime by e2e/spikes/design.e2e.ts from a resource:// substitution: no build:ui. Not product code.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

// Stops the viewfinder and its swallowing, if armed.
const ARRET = `typeof globalThis.__viseurArret === "function" && globalThis.__viseurArret(); typeof globalThis.__viseurAvaler === "function" && globalThis.__viseurAvaler()`;

const clone = (v) => {
  try {
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  } catch (e) {
    return { cloneError: String(e) };
  }
};

/** The mouse events the guard swallows while armed (and 500 ms after a capture: the rest of a double click). */
const MOUSE = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "dblclick", "contextmenu"];
const GUARDED = new Set([...MOUSE, "keydown"]);

export class WebAiOsSpikeDesignParent extends JSWindowActorParent {}

export class WebAiOsSpikeDesignChild extends JSWindowActorChild {
  /** The viewfinder's sandbox: an Xray view of the page, one per window (this actor's lifetime), as §5.4 says. */
  viewfinder() {
    if (!this.sb) {
      const win = this.contentWindow;
      this.sb = Cu.Sandbox(this.document.nodePrincipal, { sandboxPrototype: win, wantXrays: true, wantComponents: false, sameZoneAs: win, sandboxName: "WebAiOs · viseur (spike)" });
      // As the retouches' sandbox: the page's legacy `Components` shim would show through the prototype.
      Object.defineProperty(this.sb, "Components", { value: undefined });
    }
    return this.sb;
  }

  /** The page's own world, Xrays waived: what lireSource reads. Never kept. */
  pageWorld() {
    const win = this.contentWindow;
    return Cu.Sandbox(this.document.nodePrincipal, { sandboxPrototype: win, wantXrays: false, wantComponents: false, sameZoneAs: win, sandboxName: "WebAiOs · source (spike)" });
  }

  /**
   * Capture listeners on this tab's chrome event handler: the first target of every event of the tab's documents, so
   * no page listener (window or document, capture or not) runs before them. A trusted event is stopped there; a trusted
   * primary click hands its target to the viewfinder (`__viseurChoisir`), a trusted Escape stops it. Untrusted events
   * (made by the page) pass untouched. Other keys reach the page.
   */
  async armGuarded(code) {
    this.unguard?.();
    const sb = this.viewfinder();
    const doc = this.document;
    const h = this.docShell.chromeEventHandler;
    const seen = (this.seen = []);
    let picked = false;
    const mouse = (e) => {
      if (!e.isTrusted) return;
      const inTop = e.target?.ownerDocument === doc;
      seen.push(e.type + ":" + (inTop ? "top" : "other"));
      e.preventDefault();
      e.stopImmediatePropagation();
      // Gecko also sends `click` for the middle and right buttons to chrome listeners (content gets auxclick): primary only.
      if (e.type === "click" && e.button === 0 && !picked && inTop && typeof sb.__viseurChoisir === "function") {
        picked = true;
        sb.__viseurChoisir(e.target);
      }
    };
    const key = (e) => {
      if (!e.isTrusted || e.key !== "Escape") return;
      seen.push("keydown:Escape");
      e.preventDefault();
      e.stopImmediatePropagation();
      if (typeof sb.__viseurArret === "function") sb.__viseurArret();
    };
    for (const t of MOUSE) h.addEventListener(t, mouse, true);
    h.addEventListener("keydown", key, true);
    let timer;
    const unguard = (this.unguard = () => {
      clearTimeout(timer);
      for (const t of MOUSE) h.removeEventListener(t, mouse, true);
      h.removeEventListener("keydown", key, true);
      if (this.unguard === unguard) this.unguard = null;
    });
    let r = null;
    try {
      r = await Cu.evalInSandbox(code, sb, "latest", "webaios-viseur.js", 1);
    } finally {
      // After a capture, the rest of a double click is swallowed for 500 ms; else at once.
      if (r) timer = setTimeout(unguard, 500);
      else unguard();
    }
    return r;
  }

  // The chrome event handler outlives this document (it is the tab's): the guard must go with the window.
  didDestroy() {
    this.unguard?.();
  }

  async receiveMessage(msg) {
    const d = msg.data ?? {};
    switch (msg.name) {
      case "info":
        return { remoteType: Services.appinfo.remoteType, processType: Services.appinfo.processType, top: this.browsingContext.top === this.browsingContext, uri: this.document.documentURI };
      // The viewfinder script, as is; the promise's value is the query's answer (never a spontaneous message).
      case "arm":
        return clone(await Cu.evalInSandbox(d.code, this.viewfinder(), "latest", "webaios-viseur.js", 1));
      case "stop":
        Cu.evalInSandbox(ARRET, this.viewfinder(), "latest", "webaios-viseur-arret.js", 1);
        return true;
      // A probe in the viewfinder's sandbox (what it sees).
      case "probe":
        try {
          return clone(Cu.evalInSandbox(d.code, this.viewfinder(), "latest", "probe.js", 1));
        } catch (e) {
          return { error: String(e) };
        }
      // The lireSource expression, in the page's world, Xrays waived. The parent checks the shape (sourceSaine).
      case "source":
        try {
          return clone(Cu.evalInSandbox(d.code, this.pageWorld(), "latest", "webaios-source.js", 1));
        } catch (e) {
          return { error: String(e) };
        }
      // Test only: code run by the page itself (its eval), to read what the page saw.
      case "page":
        try {
          return clone(this.contentWindow.wrappedJSObject.eval(d.code));
        } catch (e) {
          return { error: String(e) };
        }
      // The S1 fix: the viewfinder with a guard on the chrome event handler (in front of every page listener).
      case "armGuarded":
        return clone(await this.armGuarded(d.code));
      case "guardSeen":
        return (this.seen ?? []).slice();
      // Test only: this tab's chrome event handler's listeners of the guarded types (capture), and all of them.
      case "listeners": {
        const all = Cc["@mozilla.org/eventlistenerservice;1"].getService(Ci.nsIEventListenerService).getListenerInfoFor(this.docShell.chromeEventHandler);
        return { all: all.length, guarded: all.filter((l) => GUARDED.has(l.type) && l.capturing).length };
      }
      // Test only: the viewfinder's host elements, read through Xrays (works under any CSP).
      case "hosts":
        return this.document.querySelectorAll("webaios-viseur").length;
      // Test only: the hover frame and its label, inside the closed shadow root (system principal reads it).
      case "frame": {
        const host = this.document.querySelector("webaios-viseur");
        const root = host?.openOrClosedShadowRoot;
        if (!root) return null;
        const [cadre, etiquette] = root.children;
        const s = (el) => ({ display: el.style.display, left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height });
        return { cadre: s(cadre), etiquette: { ...s(etiquette), text: etiquette.textContent } };
      }
      // Test only: a capture-phase listener on the chrome event handler (in front of every page listener), counting
      // what it sees: an alternative the parent may weigh.
      case "front":
        if (!this.front) {
          this.front = [];
          const h = this.docShell.chromeEventHandler;
          for (const t of ["mousedown", "mouseup", "click"]) h.addEventListener(t, (e) => this.front.push(t + ":" + e.isTrusted), true);
        }
        return this.front.slice();
    }
    return undefined;
  }
}
