// The design mode's viewfinder on a site app's home (spike S6): the home is a resource:// frame of the bar, in the
// parent process, so no actor reaches it; the chrome does the actor's work (chrome/agent/design-actor.ts) itself, with
// the same queries and answers. The frame dies when the home is left (Svelte removes it): every access is in a try.

/** The mouse events the guard swallows (while armed, and 500 ms after a capture: the rest of a double click). */
export const MOUSE = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "dblclick", "contextmenu"];

// In the parent process evalInSandbox refuses a plain filename (« unsafe filename »).
const FILE = "chrome://browser/content/webaios/";

/** Every answer is plain data: what the home's world made is never handed on as is. */
function clone(v: unknown): unknown {
  try {
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

/** The actor's work on a site app's home frame, done by the chrome (spike S6): same query names and answers. */
export function homeViewfinder(frame: HTMLIFrameElement): { query(name: "arm" | "stop" | "source" | "unguard", data?: { code?: string }): Promise<unknown> } {
  let sandbox: any = null;
  let sandboxDoc: Document | null = null;
  let unguardCurrent: (() => void) | null = null;

  /** The viewfinder's sandbox: an Xray view of the home (its objects unseen, its hooks never called), one per document. */
  const viewfinder = (hdoc: Document, hwin: Window) => {
    if (!sandbox || sandboxDoc !== hdoc) {
      sandbox = Cu.Sandbox((hdoc as any).nodePrincipal, { sandboxPrototype: hwin, wantXrays: true, wantComponents: false, sameZoneAs: hwin, sandboxName: "WebAiOs · viseur" });
      // The legacy `Components` shim would show through the prototype.
      Object.defineProperty(sandbox, "Components", { value: undefined });
      sandboxDoc = hdoc;
    }
    return sandbox;
  };

  const unguard = () => {
    try {
      unguardCurrent?.();
    } catch {
      unguardCurrent = null;
    }
  };

  /**
   * The actor's guard on the frame's chrome event handler (the <iframe> itself, S6): every trusted mouse event of the
   * home is stopped before the home's listeners; a trusted primary click in the home's document picks its target once,
   * a trusted Escape stops the viewfinder, the home's pagehide ends both. Events aimed at the <iframe> itself (the bar's) pass.
   */
  const guard = (sb: any, hdoc: Document, onHide: () => void) => {
    unguard();
    const h = frame;
    let picked = false;
    const stopViewfinder = () => {
      try {
        if (typeof sb.__viseurArret === "function") sb.__viseurArret();
      } catch {
        // The home's document is gone.
      }
    };
    const inHome = (t: any) => {
      try {
        return t === hdoc || t?.ownerDocument === hdoc;
      } catch {
        return false;
      }
    };
    const mouse = (e: MouseEvent) => {
      if (!e.isTrusted || e.target === h) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Gecko also sends `click` to chrome listeners for the middle and right buttons (the page gets auxclick).
      if (e.type === "click" && e.button === 0 && !picked && (e.target as Node | null)?.ownerDocument === hdoc && typeof sb.__viseurChoisir === "function") {
        picked = true;
        try {
          sb.__viseurChoisir(e.target);
        } catch {
          // A failed pick ends the viewfinder (its query answers null) rather than leave the home swallowed.
          try {
            stopViewfinder();
          } finally {
            off();
          }
        }
      }
    };
    const key = (e: KeyboardEvent) => {
      if (!e.isTrusted || e.key !== "Escape" || !inHome(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stopViewfinder();
    };
    const hide = (e: Event) => {
      if (!e.isTrusted || e.target !== hdoc) return;
      try {
        stopViewfinder();
      } finally {
        off();
        onHide();
      }
    };
    for (const t of MOUSE) h.addEventListener(t, mouse as EventListener, true);
    h.addEventListener("keydown", key as EventListener, true);
    h.addEventListener("pagehide", hide, true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = () => {
      clearTimeout(timer);
      for (const t of MOUSE) h.removeEventListener(t, mouse as EventListener, true);
      h.removeEventListener("keydown", key as EventListener, true);
      h.removeEventListener("pagehide", hide, true);
      if (unguardCurrent === off) unguardCurrent = null;
    };
    unguardCurrent = off;
    return { off, later: (ms: number) => (timer = setTimeout(off, ms)) };
  };

  async function arm(code: string): Promise<unknown> {
    let g!: ReturnType<typeof guard>;
    let pending!: Promise<unknown>;
    let hidden!: (v: null) => void;
    const gone = new Promise<null>((ok) => (hidden = ok));
    try {
      const hdoc = frame.contentDocument!;
      const hwin = hdoc.defaultView!;
      // Only where the home's events reach the frame first (S6); else nothing is set.
      if ((hwin as any).docShell.chromeEventHandler !== frame) return null;
      // Only the app's served home (never a system-principal document, nor the frame's initial about:blank).
      if ((hdoc as any).nodePrincipal.isSystemPrincipal || !hdoc.documentURI.startsWith("resource://webaios-site-")) return null;
      const sb = viewfinder(hdoc, hwin);
      g = guard(sb, hdoc, () => hidden(null));
      pending = Promise.resolve(Cu.evalInSandbox(code, sb, "latest", FILE + "webaios-viseur.js", 1));
    } catch {
      unguard();
      return null;
    }
    let r: unknown = null;
    try {
      r = await Promise.race([pending, gone]);
    } catch {
      r = null;
    } finally {
      // After a capture the rest of a double click is swallowed for 500 ms (__viseurAvaler); else at once.
      if (r) g.later(500);
      else g.off();
    }
    return clone(r);
  }

  return {
    async query(name, data) {
      const code = typeof data?.code === "string" ? data.code : "";
      switch (name) {
        case "arm":
          return arm(code);
        case "stop":
          // Synchronous: « Entrer dans le site » removes the frame right after the state change that calls this.
          try {
            if (sandbox) Cu.evalInSandbox(code, sandbox, "latest", FILE + "webaios-viseur-arret.js", 1);
          } catch {
            // The home's document is gone, the viewfinder with it.
          }
          unguard();
          return true;
        // lireSource's expression in the home's own world (Xrays waived), in a sandbox thrown away after.
        case "source":
          try {
            const hdoc = frame.contentDocument!;
            const hwin = hdoc.defaultView!;
            const world = Cu.Sandbox((hdoc as any).nodePrincipal, { sandboxPrototype: hwin, wantXrays: false, wantComponents: false, sameZoneAs: hwin, sandboxName: "WebAiOs · source" });
            return clone(Cu.evalInSandbox(code, world, "latest", FILE + "webaios-source.js", 1));
          } catch {
            return null;
          }
        case "unguard":
          unguard();
          return true;
      }
      return null;
    },
  };
}
