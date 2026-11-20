// The design mode's viewfinder actor (spec §5.4). Its guard on chromeEventHandler
// runs before any page listener, so a page listening on window in capture never sees the user's click.
// The child exists only when the parent asks (no events) and never sends a message of its own; the viewfinder's code
// comes from the parent with each query (chrome/store/design-copies.ts), so it changes without a rebuild.
// Kept small: the build copies this file, so any change here needs a rebuild of the app (build:ui).

// An actor module has no timers of its own.
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

/** The mouse events the guard swallows (while armed, and 500 ms after a capture: the rest of a double click). */
const MOUSE = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "dblclick", "contextmenu"];

/** Every answer is plain data: what the page's world made is never handed to the parent as is. */
function clone(v: unknown): unknown {
  try {
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

export class RessacDesignParent extends JSWindowActorParent {}

export class RessacDesignChild extends JSWindowActorChild {
  private viewfinderSandbox: any = null;
  private unguardCurrent: (() => void) | null = null;

  /** The viewfinder's sandbox: an Xray view of the page (the page's objects unseen, its hooks never called), one per window. */
  private viewfinder(): any {
    if (!this.viewfinderSandbox) {
      const win = this.contentWindow;
      this.viewfinderSandbox = Cu.Sandbox((this.document as any).nodePrincipal, { sandboxPrototype: win, wantXrays: true, wantComponents: false, sameZoneAs: win, sandboxName: "Ressac · viewfinder" });
      // The page's legacy `Components` shim would show through the prototype.
      Object.defineProperty(this.viewfinderSandbox, "Components", { value: undefined });
    }
    return this.viewfinderSandbox;
  }

  /**
   * Capture listeners on this window's chrome event handler: the first target of every event of the documents it
   * handles, in front of any page listener (window or document, capture or bubble). A trusted mouse event is stopped
   * there. In the top window (`sandbox` given), a trusted primary click in its own document hands its target to the
   * viewfinder once, and a trusted Escape stops it. Untrusted events (the page's own) pass untouched, as in Electron.
   */
  private guard(sandbox: any): { unguard: () => void; later: (ms: number) => void } {
    this.unguardCurrent?.();
    const h = this.docShell.chromeEventHandler;
    const doc = this.document;
    let picked = false;
    const mouse = (e: MouseEvent) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Gecko also sends `click` to chrome listeners for the middle and right buttons (the page gets auxclick).
      if (sandbox && e.type === "click" && e.button === 0 && !picked && (e.target as Node | null)?.ownerDocument === doc && typeof sandbox.__viewfinderPick === "function") {
        picked = true;
        try {
          sandbox.__viewfinderPick(e.target);
        } catch {
          // A failed pick ends the viewfinder (its query answers null) rather than leave the page swallowed.
          try {
            if (typeof sandbox.__viewfinderStop === "function") sandbox.__viewfinderStop();
          } finally {
            unguard();
          }
        }
      }
    };
    const key = (e: KeyboardEvent) => {
      if (!e.isTrusted || e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (typeof sandbox.__viewfinderStop === "function") sandbox.__viewfinderStop();
    };
    // A page kept in the bfcache is never destroyed (no didDestroy): leaving it ends the viewfinder and the guard.
    const hide = (e: Event) => {
      if (!e.isTrusted || e.target !== doc) return;
      try {
        if (sandbox && typeof sandbox.__viewfinderStop === "function") sandbox.__viewfinderStop();
      } finally {
        unguard();
      }
    };
    for (const t of MOUSE) h.addEventListener(t, mouse, true);
    if (sandbox) h.addEventListener("keydown", key, true);
    h.addEventListener("pagehide", hide, true);
    let timer: unknown;
    const unguard = () => {
      clearTimeout(timer);
      for (const t of MOUSE) h.removeEventListener(t, mouse, true);
      h.removeEventListener("keydown", key, true);
      h.removeEventListener("pagehide", hide, true);
      if (this.unguardCurrent === unguard) this.unguardCurrent = null;
    };
    this.unguardCurrent = unguard;
    return { unguard, later: (ms) => (timer = setTimeout(unguard, ms)) };
  }

  private async arm(code: string): Promise<unknown> {
    const sandbox = this.viewfinder();
    const guard = this.guard(sandbox);
    let r: unknown = null;
    try {
      r = await Cu.evalInSandbox(code, sandbox, "latest", "ressac-viewfinder.js", 1);
    } finally {
      // After a capture the rest of a double click is swallowed for 500 ms (Electron's __viewfinderSwallow); else at once.
      if (r) guard.later(500);
      else guard.unguard();
    }
    return clone(r);
  }

  // The chrome event handler is the tab's (or the frame's), not this document's: the guard goes with the window.
  didDestroy(): void {
    this.unguardCurrent?.();
  }

  async receiveMessage(m: { name: string; data?: { code?: unknown } }): Promise<unknown> {
    const code = typeof m.data?.code === "string" ? m.data.code : "";
    const top = this.browsingContext === this.browsingContext.top;
    switch (m.name) {
      case "arm":
        return top ? this.arm(code) : null;
      case "stop":
        if (this.viewfinderSandbox) Cu.evalInSandbox(code, this.viewfinderSandbox, "latest", "ressac-viewfinder-stop.js", 1);
        // Also ends the 500 ms swallow after a capture, as Electron's ARRET does with __viewfinderSwallow.
        this.unguardCurrent?.();
        return true;
      // lireSource's expression in the page's own world (Xrays waived), in a sandbox thrown away after.
      case "source":
        try {
          const win = this.contentWindow;
          const world = Cu.Sandbox((this.document as any).nodePrincipal, { sandboxPrototype: win, wantXrays: false, wantComponents: false, sameZoneAs: win, sandboxName: "Ressac · source" });
          return clone(Cu.evalInSandbox(code, world, "latest", "ressac-source.js", 1));
        } catch {
          return null;
        }
      // A frame of another process: its own chrome event handler, which the top window's guard does not reach. Mouse
      // only, never picks. A frame of the top's process is already behind the top's guard.
      case "guard":
        if (top || !this.manager.isProcessRoot) return false;
        this.guard(null);
        return true;
      case "unguard":
        this.unguardCurrent?.();
        return true;
    }
    return null;
  }
}

export class RessacDesignFramesParent extends JSWindowActorParent {}

/**
 * The same viewfinder on a site app's home, a remote frame of the frames group (null principal). It reads only the
 * home copy the parent names in each query (`home`: a `resource://ressac-frames-…/sites/` prefix the parent computes; the child checks that prefix, not the token's shape).
 */
export class RessacDesignFramesChild extends RessacDesignChild {
  async receiveMessage(m: { name: string; data?: { code?: unknown; home?: unknown } }): Promise<unknown> {
    const home = m.data?.home;
    const served = typeof home === "string" && home.startsWith("resource://ressac-frames-") && home.endsWith("/sites/") && this.document.documentURI.startsWith(home);
    if ((m.name === "arm" || m.name === "source" || m.name === "guard") && !served) return null;
    return super.receiveMessage(m);
  }
}
