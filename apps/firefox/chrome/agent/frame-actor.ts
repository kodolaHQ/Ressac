// The actor of the agent-written frames (widget displays, site-app homes, action components): remote <browser>s in one
// web content process (chrome/window/remote-frame.ts). The child runs in that untrusted process and stays minimal: it
// forwards a few bounded messages and posts the parent's data into the page. The parent only looks up the callback the
// frame's owner registered; it never acts itself. Packaged: a change here needs build:ui.

/** The page's own events (CustomEvent on its window) and the message each becomes. */
const PAGE_EVENTS = { "ressac-open": "open", "ressac-home": "home", "ressac-component": "component" } as const;
/** A string detail is clipped to this many characters; anything else is dropped. */
const MAX_DETAIL = 65536;
/** Set by the parent in sharedData when RESSAC_TEST_FRAMES is on (a dev build): a page cannot write it. */
export const FRAMES_TEST_KEY = "ressac-frames-test";

type Callback = (name: string, data: unknown) => void;
const owners = new WeakMap<object, Callback>();

/** The frame owner (RemoteFrame) listens to the messages of its `<browser>`; returns how to stop. */
export function onFrameMessage(browser: Element, cb: Callback): () => void {
  owners.set(browser, cb);
  return () => {
    if (owners.get(browser) === cb) owners.delete(browser);
  };
}

export class RessacFrameParent extends JSWindowActorParent {
  receiveMessage(msg: { name: string; data: unknown }): void {
    const browser = this.browsingContext?.top?.embedderElement;
    if (browser) owners.get(browser)?.(msg.name, msg.data);
  }
}

export class RessacFrameChild extends JSWindowActorChild {
  private off: (() => void)[] = [];

  handleEvent(e: Event): void {
    if (e.type !== "DOMWindowCreated") {
      if (e.type === "DOMContentLoaded" && e.target === this.document) this.sendAsyncMessage("loaded", { uri: this.document.documentURI });
      return;
    }
    const win = this.contentWindow;
    const doc = this.document;
    const handler = this.docShell.chromeEventHandler;
    // On the chrome event handler, in front of any page listener; only the user's own (trusted) events count.
    const trusted = (type: string, fn: (e: Event) => void) => {
      handler.addEventListener(type, fn, true);
      this.off.push(() => handler.removeEventListener(type, fn, true));
    };
    trusted("pointerdown", (ev) => ev.isTrusted && this.sendAsyncMessage("press", {}));
    trusted("focus", (ev) => ev.isTrusted && (ev.target === win || ev.target === doc) && this.sendAsyncMessage("focus", {}));
    for (const [type, name] of Object.entries(PAGE_EVENTS)) {
      // The page makes these events itself (untrusted): only a string detail goes on, clipped.
      const fn = (ev: Event) => {
        const detail = (ev as CustomEvent).detail;
        if (typeof detail !== "string") return;
        const text = detail.slice(0, MAX_DETAIL);
        this.sendAsyncMessage(name, name === "open" ? { url: text } : { detail: text });
      };
      (win as any).addEventListener(type, fn, false, true);
      this.off.push(() => win.removeEventListener(type, fn));
    }
  }

  didDestroy(): void {
    for (const f of this.off.splice(0)) f();
  }

  async receiveMessage(msg: { name: string; data: any }): Promise<unknown> {
    if (msg.name === "send") {
      this.contentWindow.postMessage(Cu.cloneInto(msg.data?.data, this.contentWindow), "*");
      return undefined;
    }
    if (msg.name === "test") {
      if (!Services.cpmm.sharedData.get(FRAMES_TEST_KEY)) throw new Error("test hook off");
      const win = this.contentWindow;
      const sandbox = Cu.Sandbox(this.document.nodePrincipal, { sandboxPrototype: win, wantXrays: true, sameZoneAs: win });
      return JSON.stringify(await Cu.evalInSandbox(String(msg.data?.expr), sandbox));
    }
    return undefined;
  }
}
