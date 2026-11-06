// Throwaway actor of plan 35's spike (docs/superpowers/notes/2026-11-06-mode-design-firefox-spikes.md). Registered at
// runtime by e2e/spikes/design.e2e.ts from a resource:// substitution: no build:ui. Not product code.

// Electron's ARRET (apps/navigateur/src/main/design/viseur.ts), not exported there.
const ARRET = `typeof globalThis.__viseurArret === "function" && globalThis.__viseurArret(); typeof globalThis.__viseurAvaler === "function" && globalThis.__viseurAvaler()`;

const clone = (v) => {
  try {
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  } catch (e) {
    return { cloneError: String(e) };
  }
};

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

  /** The page's own world, Xrays waived: what lireSource reads in Electron's main world. Never kept. */
  pageWorld() {
    const win = this.contentWindow;
    return Cu.Sandbox(this.document.nodePrincipal, { sandboxPrototype: win, wantXrays: false, wantComponents: false, sameZoneAs: win, sandboxName: "WebAiOs · source (spike)" });
  }

  async receiveMessage(msg) {
    const d = msg.data ?? {};
    switch (msg.name) {
      case "info":
        return { remoteType: Services.appinfo.remoteType, processType: Services.appinfo.processType, top: this.browsingContext.top === this.browsingContext, uri: this.document.documentURI };
      // Electron's scriptViseur(), as is; the promise's value is the query's answer (never a spontaneous message).
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
      // Electron's lireSource expression, in the page's world, Xrays waived. The parent checks the shape (sourceSaine).
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
      // what it sees: an alternative the parent may weigh, not what Electron does.
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
