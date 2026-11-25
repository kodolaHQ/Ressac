// The actor of the agent-written frames (widget displays, site-app homes, action components): remote <browser>s in one
// web content process (chrome/window/remote-frame.ts). The child runs in that untrusted process and stays minimal: it
// forwards a few bounded messages and posts the parent's data into the page. The parent only looks up the callback the
// frame's owner registered; it never acts itself. Packaged: a change here needs build:ui.

/** The page's own events (CustomEvent on its window) and the message each becomes. */
const PAGE_EVENTS = { "ressac-open": "open", "ressac-home": "home", "ressac-component": "component" } as const;
/** A string detail is clipped to this many characters; anything else is dropped. */
const MAX_DETAIL = 65536;
import { isBlockedAddress } from "../store/ui-network";
import { FRAMES_TEST_KEY, FRAMES_GROUP } from "../window/frames-root";

const POLICY_CONTRACT = "@ressac/frames-network-policy;1";
let policed = false;
/**
 * The frames' process refuses http(s)/ws(s) itself, as the parent's policy does for in-process UI documents: a
 * WebSocket resolves its host name in the parent before its channel opens (WebSocketChannel::DoAdmissionDNS, measured
 * in e2e/frames.e2e.ts), so the parent's opening-request observer alone lets a name out. Only in our webIsolated process.
 */
function policeProcess(): void {
  if (policed) return;
  policed = true;
  if (!Services.appinfo.remoteType?.startsWith(`webIsolated=resource://${FRAMES_GROUP}-`)) return;
  const policy = {
    classID: Components.ID("{3f6b2d84-9c1e-4a7f-b5d2-6e0c8a4f1b93}"),
    QueryInterface: ChromeUtils.generateQI(["nsIContentPolicy", "nsIFactory"]),
    createInstance: (iid: unknown) => (policy.QueryInterface as (iid: unknown) => unknown)(iid),
    shouldLoad: (location: { spec: string }) => (isBlockedAddress(location.spec) ? Ci.nsIContentPolicy.REJECT_REQUEST : Ci.nsIContentPolicy.ACCEPT),
    shouldProcess: () => Ci.nsIContentPolicy.ACCEPT,
  };
  try {
    Components.manager.QueryInterface(Ci.nsIComponentRegistrar).registerFactory(policy.classID, "Ressac frames network policy", POLICY_CONTRACT, policy);
    Services.catMan.addCategoryEntry("content-policy", POLICY_CONTRACT, POLICY_CONTRACT, false, true);
  } catch (e) {
    // The parent's observer still cuts every channel; only a WebSocket's name lookup stays open.
    console.error("[ui-network] the frames' policy did not install:", e);
  }
}

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
    const cb = browser && owners.get(browser);
    if (!cb) return;
    // The sender may be a compromised process: only these names, string fields, clipped. `press`/`focus` cannot be
    // guaranteed trusted; owners treat them as the same hint the old in-process listener gave.
    const d = (msg.data ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.slice(0, MAX_DETAIL) : null);
    switch (msg.name) {
      case "press":
      case "focus":
        return cb(msg.name, {});
      case "loaded": {
        const uri = str(d.uri);
        return uri === null ? undefined : cb("loaded", { uri });
      }
      case "open": {
        const url = str(d.url);
        return url === null ? undefined : cb("open", { url });
      }
      case "home":
      case "component": {
        const detail = str(d.detail);
        return detail === null ? undefined : cb(msg.name, { detail });
      }
    }
  }
}

/** Removed from every document of the frames' process, nested ones included (RessacFrameRtc, allFrames). */
const RTC_REMOVED = ["RTCPeerConnection", "webkitRTCPeerConnection"];
/** Removed from Navigator.prototype, where the native getter and method live (an own value on `navigator` alone left the getter reachable). */
const NAVIGATOR_REMOVED = ["mediaDevices", "mozGetUserMedia"];

/**
 * No document of the frames' process makes a PeerConnection: the parent's blocker refuses one only after it has
 * reached the socket process, and that refused connection's teardown made the socket process exit (status 1) and
 * stalled a tab's call started at that moment (measured in e2e/ui-network.e2e.ts). Non-configurable own values, set
 * at DOMWindowCreated, before the document's first script and before the script that created an about:blank frame
 * reads it.
 */
export class RessacFrameRtcChild extends JSWindowActorChild {
  handleEvent(): void {
    const win = (this.contentWindow as any).wrappedJSObject;
    for (const name of RTC_REMOVED) Object.defineProperty(win, name, { value: undefined, writable: false, configurable: false, enumerable: false });
    for (const name of NAVIGATOR_REMOVED) Object.defineProperty(win.Navigator.prototype, name, { value: undefined, writable: false, configurable: false, enumerable: false });
  }
}

export class RessacFrameChild extends JSWindowActorChild {
  private off: (() => void)[] = [];

  handleEvent(e: Event): void {
    // DOMWindowCreated comes before the page's first load.
    policeProcess();
    if (e.type !== "DOMWindowCreated") {
      if (e.type === "DOMContentLoaded" && e.target === this.document) this.sendAsyncMessage("loaded", { uri: this.document.documentURI });
      return;
    }
    const win = this.contentWindow;
    const doc = this.document;
    const handler = this.docShell.chromeEventHandler;
    if (!handler) return;
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
    for (const f of this.off.splice(0)) {
      try {
        f();
      } catch {
        // A dead wrapper: the rest still go.
      }
    }
  }

  async receiveMessage(msg: { name: string; data: any }): Promise<unknown> {
    if (msg.name === "send") {
      this.contentWindow.postMessage(Cu.cloneInto(msg.data?.data, this.contentWindow), "*");
      return undefined;
    }
    if (msg.name === "test") {
      if (!Services.cpmm.sharedData.get(FRAMES_TEST_KEY)) throw new Error("test hook off");
      const win = this.contentWindow;
      // `chrome`: a system sandbox, for what only the chrome sees (a closed shadow root).
      const principal = msg.data?.chrome ? Services.scriptSecurityManager.getSystemPrincipal() : (this.document as any).nodePrincipal;
      const sandbox = Cu.Sandbox(principal, { sandboxPrototype: win, wantXrays: true, sameZoneAs: win });
      return JSON.stringify(await Cu.evalInSandbox(String(msg.data?.expr), sandbox));
    }
    return undefined;
  }
}
