import { afterEach, describe, expect, it, vi } from "vitest";

// The UI's network net (chrome/store/ui-network.ts) on fake objects (no proxy, no
// ressac-icone here).

const ACCEPT = 1;
const REJECT = -1;
const MAIL = 1;
const observers: [unknown, string][] = [];
const categories: string[] = [];
let registerFactory = vi.fn();
const blockers: unknown[] = [];
const windowGlobals = new Map<number, unknown>();
Object.assign(globalThis as any, {
  Ci: { nsIContentPolicy: { ACCEPT, REJECT_REQUEST: REJECT, TYPE_WEB_TRANSPORT: 59 }, nsIDocShell: { APP_TYPE_MAIL: MAIL }, nsIComponentRegistrar: "registrar", nsIChannel: "channel", nsICachingChannel: { LOAD_NO_NETWORK_IO: 1 << 26 } },
  Cr: { NS_BINDING_ABORTED: 0x804b0002 },
  Components: { ID: (s: string) => s, manager: { QueryInterface: () => ({ registerFactory: (...a: unknown[]) => registerFactory(...a) }) } },
  ChromeUtils: { generateQI: () => () => ({}), importESModule: () => ({ webrtcUI: { addPeerConnectionBlocker: (b: unknown) => blockers.push(b) } }) },
  WindowGlobalParent: { getByInnerWindowId: (id: number) => windowGlobals.get(id) ?? null },
  Services: {
    obs: { addObserver: (o: unknown, topic: string) => observers.push([o, topic]), notifyObservers: vi.fn() },
    catMan: { addCategoryEntry: (c: string) => categories.push(c) },
    wm: { getOuterWindowWithId: () => null },
  },
});
const N = await import("../chrome/store/ui-network");
const { framesOrigin } = await import("../chrome/window/frames-root");
const O = framesOrigin();

/** A document at `uri` in a chrome (or content) context embedded by `embedder` (null: a window's top). */
const doc = (uri: string, embedder: object | null = null, isContent = false): any => ({ documentURI: uri, defaultView: { browsingContext: { isContent, embedderElement: embedder } } });
const frameIn = (owner: unknown, appType = 0): any => ({ ownerDocument: owner, frameLoader: { docShell: { appType } } });
const browserXhtml = doc("chrome://browser/content/browser.xhtml");
const sidebar = doc("chrome://browser/content/ressac/sidebar.html", frameIn(browserXhtml));
const widget = doc(`${O}/widgets/a/display-1.html`, frameIn(sidebar));
const widgetBlank = doc("about:blank", frameIn(widget));
const tab = doc(`${O}/sites/x/index.html`, null, true);
const li = (loadingDocument: unknown, browsingContext: unknown = null): any => ({ loadingDocument, browsingContext, targetBrowsingContext: browsingContext, externalContentPolicyType: 3 });
/** A frame's navigation as DocumentLoadListener builds it (LoadInfo::CreateForFrame): browsingContext is the parent's, targetBrowsingContext the frame's. */
const frameNav = (parent: unknown, frame: unknown): any => ({ loadingDocument: null, browsingContext: parent, targetBrowsingContext: frame, externalContentPolicyType: 7 });
const topChrome = { isContent: false, embedderElement: null };

afterEach(() => {
  vi.restoreAllMocks();
  registerFactory = vi.fn();
});

describe("ui-network", () => {
  it("UI_PREFIXES holds the frames origin and none of the old per-frame prefixes", () => {
    expect(N.UI_PREFIXES).toContain(`${O}/`);
    const principal = (spec: string) => ({ loadingDocument: null, browsingContext: null, loadingPrincipal: { spec } });
    expect(N.isUiLoad(principal(`${O}/widgets/a/display.html`))).toBe(true);
    expect(N.isUiLoad(principal(`${O}X/widgets/a/display.html`)), "another host").toBeFalsy();
    expect(N.UI_PREFIXES.some((p) => /ressac-(widget|site|component)-/.test(p))).toBe(false);
  });

  it("the UI's loads: http, https, ws and wss are refused whatever the host, 127.0.0.1 and localhost included; nothing escapes the net", () => {
    for (const u of ["http://127.0.0.1:1/x", "https://localhost/", "ws://a.example/", "wss://b.example/", "HTTP://X.EXAMPLE/"]) expect(N.isBlockedAddress(u), u).toBe(true);
  });

  it("chrome:, resource:, moz-extension:, data:, blob:, page-icon:, moz-remote-image: pass; a nested view-source: is judged by its inner URI", () => {
    for (const u of [
      "chrome://browser/content/ressac/sidebar.html",
      `${O}/widgets/a/display-1.html`,
      "moz-extension://u/i.png",
      "data:image/png;base64,AA",
      "blob:null/1",
      "page-icon:http://a.example/",
      "moz-remote-image://?url=http%3A%2F%2Fa.example%2F",
      "about:blank",
    ])
      expect(N.isBlockedAddress(u), u).toBe(false);
    for (const u of ["view-source:http://a.example/", "view-source:view-source:https://a.example/"]) expect(N.isBlockedAddress(u), u).toBe(true);
  });

  it("a document is the UI's by its own address or an in-process ancestor's; browser.xhtml, a tab (even on a frames address) and a document-less chrome channel are not", () => {
    expect(N.isUiDocument(sidebar)).toBe(true);
    expect(N.isUiDocument(widget)).toBe(true);
    expect(N.isUiDocument(widgetBlank)).toBe(true);
    expect(N.isUiDocument(doc("resource://ressac-test-net/p.html", frameIn(sidebar)))).toBe(true);
    expect(N.isUiDocument(browserXhtml)).toBe(false);
    expect(N.isUiDocument(tab)).toBe(false);
    expect(N.isUiDocument(null)).toBe(false);
    expect(N.isUiDocument({ documentURI: "chrome://browser/content/ressac/sidebar.html" } as any)).toBe(false);
    const dead = Object.defineProperty({ documentURI: "about:blank" }, "defaultView", { get: () => { throw new TypeError("can't access dead object"); } });
    expect(N.isUiDocument(dead as any)).toBe(false);
    expect(N.isUiLoad(li(null, null)), "a document-less chrome channel (action image, add-on install)").toBe(false);
  });

  it("a frame's navigation, with neither loading document nor node, is the UI's by its target context's embedder, not its parent's", () => {
    const parentOf = (owner: any) => owner.defaultView.browsingContext;
    expect(N.isUiLoad(frameNav(parentOf(widget), { isContent: false, embedderElement: frameIn(widget) }))).toBe(true);
    expect(N.isUiLoad(frameNav(topChrome, { isContent: false, embedderElement: frameIn(browserXhtml, MAIL) })), "a cut top frame: its parent is browser.xhtml's top context").toBe(true);
    expect(N.isUiLoad(frameNav(topChrome, { isContent: false, embedderElement: frameIn(browserXhtml) })), "an uncut frame of browser.xhtml").toBe(false);
    expect(N.isUiLoad(frameNav(parentOf(sidebar), { isContent: true, embedderElement: frameIn(sidebar) })), "a content context").toBe(false);
    expect(N.isUiLoad(li(null, null)), "an action image, an add-on").toBe(false);
  });

  it("a dedicated worker's load is judged by its associated context; a load without any context by its principal (system too for WebTransport)", () => {
    const worker = (associatedBrowsingContext: unknown): any => ({ loadingDocument: null, browsingContext: null, targetBrowsingContext: null, associatedBrowsingContext, externalContentPolicyType: 2 });
    expect(N.isUiLoad(worker({ isContent: false, embedderElement: frameIn(sidebar) })), "a worker of a frame in the sidebar").toBe(true);
    expect(N.isUiLoad(worker({ isContent: false, embedderElement: frameIn(browserXhtml, MAIL) })), "a worker of the sidebar").toBe(true);
    expect(N.isUiLoad(worker({ isContent: true, embedderElement: null })), "a tab's worker").toBe(false);
    const bare = (spec: string, isSystemPrincipal = false): any => ({ ...worker(null), loadingPrincipal: { isSystemPrincipal, spec, precursorPrincipal: null } });
    expect(N.isUiLoad(bare(`${O}/widgets/a/w.js`)), "a parent-process worker's fetch, no context: a UI principal").toBe(true);
    expect(N.isUiLoad(bare("resource://ressac-test-net/w.js")), "no context, a principal outside the prefixes").toBe(false);
    expect(N.isUiLoad(bare("", true)), "no context, system (an add-on install)").toBe(false);
    const wt = (loadingPrincipal: unknown): any => ({ loadingDocument: null, browsingContext: null, targetBrowsingContext: null, associatedBrowsingContext: null, loadingPrincipal, externalContentPolicyType: 59 });
    const opaque = (precursor: string) => ({ isSystemPrincipal: false, spec: "moz-nullprincipal:{1}", precursorPrincipal: { isSystemPrincipal: false, spec: precursor } });
    expect(N.isUiLoad(wt({ isSystemPrincipal: true, spec: "" })), "a system document").toBe(true);
    expect(N.isUiLoad(wt(opaque(`${O}/widgets/a/display-1.html`))), "a served widget").toBe(true);
    expect(N.isUiLoad(wt({ isSystemPrincipal: false, spec: `${O}/components/c/component-1.html`, precursorPrincipal: null })), "a component").toBe(true);
    expect(N.isUiLoad(wt({ isSystemPrincipal: false, spec: "https://a.example/", precursorPrincipal: null })), "a tab").toBe(false);
    expect(N.isUiLoad(wt(opaque("https://a.example/"))), "a sandboxed tab frame").toBe(false);
    expect(N.isUiLoad({ ...wt({ isSystemPrincipal: true, spec: "" }), externalContentPolicyType: 3 }), "a system image without context (an action image)").toBe(false);
  });

  it("a remote frame's load (content context) is the UI's by its top embedder's group or by a frames principal; a tab's is not", () => {
    const browser = (group: string | null) => ({ getAttribute: (n: string) => (n === "messagemanagergroup" ? group : null) });
    const content = (group: string | null, nested = false): any => {
      const top = { isContent: true, embedderElement: browser(group) };
      return nested ? { isContent: true, top, embedderElement: null } : { ...top, top };
    };
    const load = (bc: unknown, loadingPrincipal: unknown = null): any => ({ loadingDocument: null, browsingContext: bc, targetBrowsingContext: null, loadingPrincipal, externalContentPolicyType: 11 });
    expect(N.isUiLoad(load(content("ressac-frames"))), "a frame's fetch").toBe(true);
    expect(N.isUiLoad(load(content("ressac-frames", true))), "a frame's nested frame").toBe(true);
    expect(N.isUiLoad(frameNav(content("ressac-frames"), content("ressac-frames", true))), "a nested frame's navigation").toBe(true);
    const opaque = { isSystemPrincipal: false, spec: "moz-nullprincipal:{1}", precursorPrincipal: { isSystemPrincipal: false, spec: `${O}/widgets/a/display-1.html` } };
    expect(N.isUiLoad(load(content("browsers"), opaque)), "a frames principal, whatever the embedder").toBe(true);
    expect(N.isUiLoad(load(content("browsers"), { isSystemPrincipal: false, spec: "https://a.example/", precursorPrincipal: null })), "a tab").toBe(false);
    expect(N.isUiLoad(load(content(null))), "a tab without a principal").toBe(false);
    expect(N.isUiLoad(load({ isContent: true, top: { isContent: true, embedderElement: null }, embedderElement: null })), "a top context without embedder").toBe(false);
  });

  it("a remote frame's WebRTC is denied through Firefox's peer connection blockers; a tab's is left alone", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    blockers.length = 0;
    N.installUiNetwork();
    expect(blockers).toEqual([N.frameRtcBlocker]);
    const wg = (group: string, remoteType = "webIsolated=http://example.com") => ({
      browsingContext: { top: { embedderElement: group ? { getAttribute: () => group } : null } },
      domProcess: { remoteType },
    });
    windowGlobals.set(1, wg("ressac-frames"));
    windowGlobals.set(2, wg("browsers"));
    windowGlobals.set(4, wg("", `webIsolated=${O}`));
    windowGlobals.set(5, wg("", `webIsolated=${O}X`));
    const warn = vi.mocked(console.warn);
    expect(N.frameRtcBlocker({ innerWindowID: 1 })).toBe("deny");
    expect(N.frameRtcBlocker({ innerWindowID: 2 })).toBe("allow");
    expect(N.frameRtcBlocker({ innerWindowID: 4 }), "a frame whose browser was just removed").toBe("deny");
    expect(N.frameRtcBlocker({ innerWindowID: 5 }), "another host than the frames'").toBe("allow");
    expect(N.frameRtcBlocker({ innerWindowID: 3, origin: `moz-nullprincipal:{x}?${O}` }), "a frame's window already gone").toBe("deny");
    warn.mockClear();
    expect(N.frameRtcBlocker({ innerWindowID: 3, origin: "https://meet.example" }), "a tab's window already gone").toBe("allow");
    expect(N.frameRtcBlocker({ innerWindowID: 3, origin: "https://meet.example" })).toBe("allow");
    expect(warn.mock.calls.filter(([t]) => String(t).includes("already gone"))).toHaveLength(1);
  });

  it("a chain of UI-less chrome documents deeper than the walk's bound counts as the UI's (fails closed)", () => {
    let d = browserXhtml;
    for (let i = 0; i < 40; i++) d = doc("about:blank", frameIn(d));
    expect(N.isUiDocument(d)).toBe(true);
    let short = browserXhtml;
    for (let i = 0; i < 20; i++) short = doc("about:blank", frameIn(short));
    expect(N.isUiDocument(short)).toBe(false);
  });

  it("the policy rejects a UI load to the web and accepts the rest", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(N.uiPolicy.shouldLoad({ spec: "http://a.example/" }, li(widget))).toBe(REJECT);
    expect(warn).toHaveBeenCalledWith("[ui-network] refused", 3, "http://a.example/");
    expect(N.uiPolicy.shouldLoad({ spec: "data:image/png;base64,AA" }, li(widget))).toBe(ACCEPT);
    expect(N.uiPolicy.shouldLoad({ spec: "http://a.example/" }, li(tab))).toBe(ACCEPT);
    expect(N.uiPolicy.shouldProcess()).toBe(ACCEPT);
  });

  it("the net failing to install: the policy refused, frames still load; the observer refused, no UI frame gets its src", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    observers.length = categories.length = 0;
    expect(N.installUiNetwork(null)).toEqual({ policy: true, observer: true, webrtc: true });
    expect(observers.map(([, t]) => t)).toEqual(["http-on-opening-request", "PeerConnection:request"]);
    expect(categories).toEqual(["content-policy"]);
    expect(error).not.toHaveBeenCalled();
    expect(N.installUiNetwork("policy")).toEqual({ policy: false, observer: true, webrtc: true });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toMatch(/^\[ui-network\] /);
    expect(N.installUiNetwork("observer")).toEqual({ policy: true, observer: false, webrtc: true });
    registerFactory = vi.fn(() => {
      throw new Error("NS_ERROR_FACTORY_EXISTS");
    });
    expect(N.installUiNetwork()).toEqual({ policy: false, observer: true, webrtc: true });
  });

  it("the opening-request observer cancels a UI channel to the web, never another; the WebRTC refusal answers only the UI", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    observers.length = 0;
    N.installUiNetwork();
    const [opening, webrtc] = observers.map(([o]) => o as { observe(s: unknown): void });
    const channel = (spec: string, d: unknown) => ({ QueryInterface() { return this; }, URI: { spec }, loadInfo: li(d), loadFlags: 0, cancel: vi.fn() });
    for (const [spec, d, cut] of [["http://a.example/", sidebar, true], ["data:,x", sidebar, false], ["http://a.example/", tab, false]] as const) {
      const c = channel(spec, d);
      opening!.observe(c);
      expect(c.cancel.mock.calls.length, `${spec} ${d.documentURI}`).toBe(cut ? 1 : 0);
      // A cut load does no network I/O: no proxy step, no DNS prefetch.
      expect(c.loadFlags, `${spec} ${d.documentURI}`).toBe(cut ? 1 << 26 : 0);
    }
    const notify = (globalThis as any).Services.obs.notifyObservers;
    for (const [d, deny] of [[widget, true], [tab, false], [null, false]] as const) {
      notify.mockClear();
      (globalThis as any).Services.wm.getOuterWindowWithId = () => (d ? { document: d } : null);
      webrtc!.observe({ windowID: 1, callID: "c1" });
      expect(notify.mock.calls, String(d?.documentURI)).toEqual(deny ? [[null, "PeerConnection:response:deny", "c1"]] : []);
    }
  });
});
