import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ID = "reseau@agent.webaios";
const GRANT = { permissions: [], hosts: ["https://hote.test/*"], network: ["accorde.test"], allSites: false, allSitesScripts: false, scripts: false };
const HOST = "0f7c6f4e-1111-4222-8333-444455556666";

let observer: (subject: unknown) => void = () => {};
/** Firefox's ParentAPIManager: contexts by childId (their add-on id), the calls that reached Firefox, the results sent back. */
const contexts: Record<number, string> = { 1: ID, 2: "autre@mozilla.org" };
const parentApi = {
  reached: [] as string[],
  sent: [] as unknown[],
  getContextUnchecked: (childId: number) => (contexts[childId] ? { extension: { id: contexts[childId] } } : undefined),
  conduit: { sendCallResult: (_: number, r: unknown) => parentApi.sent.push(r), recv: new Map<string, (data: { path: string }, meta: unknown) => unknown>() },
};
const firefoxRecv = (data: { path: string }) => void parentApi.reached.push(data.path);
/** A request as http-on-modify-request hands it: true if the observer cancelled it. */
const request = (url: string, o: { loading?: string | null; triggering?: string | null }) => {
  let cancelled = false;
  const principal = (id: string | null | undefined) => (id === undefined ? undefined : id === null ? null : { addonId: id });
  const channel = { QueryInterface: () => channel, URI: { spec: url }, loadInfo: { loadingPrincipal: principal(o.loading), triggeringPrincipal: principal(o.triggering) }, cancel: () => (cancelled = true) };
  observer(channel);
  return cancelled;
};

/** The tabs reloaded by extensions.rechargerOnglets, by id. */
const reloads: number[] = [];
/** One tab element per id, as Firefox's tabTracker hands it: its attributes, address, container (default 0) and document. */
type FakeTab = { attrs: string[]; url: string; ctx?: number; doc?: number };
const tabElements = new Map<number, unknown>();
const tabElement = (id: number, t: FakeTab) => {
  if (!tabElements.has(id))
    tabElements.set(id, {
      hasAttribute: (a: string) => t.attrs.includes(a),
      getAttribute: (a: string) => (t.attrs.includes(a) ? `onglet-${id}` : null),
      userContextId: t.ctx ?? 0,
      isConnected: true,
      linkedBrowser: { currentURI: { spec: t.url }, get innerWindowID() { return t.doc ?? 1; }, reload: () => reloads.push(id) },
    });
  return tabElements.get(id);
};

/** The chrome module with Firefox simulated: one policy (ID → HOST), tabs by id with their attributes and address. */
async function load(
  tabs: Record<number, FakeTab> = {},
  o: { read?: string[]; requests?: unknown[][]; notified?: unknown[][]; running?: unknown[] } = {},
) {
  reloads.length = 0;
  tabElements.clear();
  vi.stubGlobal("ChromeUtils", {
    importESModule: () => ({
      AddonManager: { addAddonListener: () => {} },
      FileUtils: {},
      Management: { on: () => {} },
      ExtensionParent: {
        ParentAPIManager: parentApi,
        apiManager: {
          on: () => {},
          global: {
            tabTracker: {
              getTab: (id: number) => {
                const t = tabs[id];
                if (!t) throw new Error(`Invalid tab ID: ${id}`);
                return tabElement(id, t);
              },
            },
          },
        },
      },
    }),
  });
  vi.stubGlobal("WebExtensionPolicy", { getByID: (id: string) => (id === ID ? { mozExtensionHostname: HOST } : null), getActiveExtensions: () => (o.running ?? []).map((extension) => ({ extension })) });
  vi.stubGlobal("Ci", { nsIHttpChannel: {} });
  vi.stubGlobal("Cr", { NS_BINDING_ABORTED: 0x804b0002 });
  vi.stubGlobal("Services", { obs: { addObserver: (o: (s: unknown) => void, topic: string) => topic === "http-on-modify-request" && (observer = o) }, console: { registerListener: () => {} }, env: { get: () => "" } });
  const { createAgentExtensions } = await import("../chrome/store/agent-extensions");
  // WebAiOs tabs onglet-<n>: 5 is in a private space, 6 in another profile's, the others in the default one.
  const spaces = [
    { id: "e1", private: false, profile: "defaut" },
    { id: "e2", private: true, profile: "secret" },
    { id: "e3", private: false, profile: "autre" },
  ];
  const tabMap = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`onglet-${n}`, { id: `onglet-${n}`, spaceId: n === 5 ? "e2" : n === 6 ? "e3" : "e1" }]));
  type State = { spaces: typeof spaces; tabs: typeof tabMap };
  const listeners: ((state: State, previous: State) => void)[] = [];
  const store = { state: { spaces: spaces, tabs: tabMap } as State, subscribe: (l: (state: State, previous: State) => void) => void listeners.push(l) };
  const access = () => ({ agent: "L'agent", tabs: Object.fromEntries((o.read ?? []).map((id) => [id, { read: true, rights: [], built: false, running: false }])) });
  const host = { request: (...a: unknown[]) => (o.requests?.push(a), Promise.resolve()), notify: (...a: unknown[]) => void o.notified?.push(a) };
  const x = createAgentExtensions(store as never, {} as never, {} as never, () => host as never, access as never);
  /** A new state, as the store sends it to its subscribers. */
  const setSpaces = (e: typeof spaces) => {
    const previous = store.state;
    store.state = { ...previous, spaces: e };
    listeners.forEach((l) => l(store.state, previous));
  };
  return Object.assign(x, { setSpaces });
}
const grant = (x: Awaited<ReturnType<typeof load>>, active = true) =>
  x.handlers["extensions.scopes"]!({ [ID]: { key: "agent:reseau", grant: GRANT, profiles: ["defaut"], active: active } }, new AbortController().signal);

beforeEach(() => parentApi.conduit.recv.set("APICall", firefoxRecv));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("agent extension checkpoints", () => {
  it("capture, language, print, PDF and reader-mode tab calls of an agent extension never reach Firefox; another add-on's do", async () => {
    await load();
    parentApi.reached = [];
    parentApi.sent = [];
    const call = (childId: number, path: string, callId = 7) => parentApi.conduit.recv.get("APICall")!({ childId, callId, path } as never, {});
    for (const path of ["tabs.captureVisibleTab", "tabs.captureTab", "tabs.detectLanguage", "tabs.saveAsPDF", "tabs.print", "tabs.printPreview", "tabs.toggleReaderMode"]) call(1, path);
    call(1, "tabs.query");
    call(2, "tabs.captureVisibleTab");
    expect(parentApi.reached).toEqual(["tabs.query", "tabs.captureVisibleTab"]);
    expect(parentApi.sent).toHaveLength(7);
    expect(parentApi.sent[0]).toEqual({ childId: 1, callId: 7, path: "tabs.captureVisibleTab", error: { message: "tabs.captureVisibleTab non pris en charge par WebAiOs" } });
  });

  it("check: urlPermise accepts its own moz-extension host and a granted network domain only", async () => {
    const x = await load();
    grant(x);
    const ok = (v: unknown) => x.check(ID, "urlPermise", v);
    expect(ok(`moz-extension://${HOST}/page.html`)).toBe(true);
    expect(ok("page.html")).toBe(true);
    expect(ok("https://accorde.test/x")).toBe(true);
    expect(ok("https://hote.test/x")).toBe(true);
    for (const refused of ["data:text/html,x", "javascript:alert(1)", "moz-extension://autre-hote/page.html", "https://autre.test/", "https://u:p@accorde.test/", 42, null])
      expect(ok(refused)).toBe(false);
    // Not granted, not active, or not answered yet: nothing passes.
    expect(x.check("autre@agent.webaios", "urlPermise", "https://accorde.test/")).toBe(false);
    grant(x, false);
    expect(ok("https://accorde.test/")).toBe(false);
  });

  it("check: nothing passes before the grants are known; a checkpoint waits for them at most SCOPES_WAIT_MS", async () => {
    const x = await load();
    expect(x.check(ID, "urlPermise", "https://accorde.test/")).toBe(false);
    vi.useFakeTimers();
    try {
      let waited = false;
      void x.scopesKnown().then(() => (waited = true));
      await vi.advanceTimersByTimeAsync(4_900);
      expect(waited).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(waited).toBe(true);
      expect(x.check(ID, "urlPermise", "https://accorde.test/")).toBe(false);
      // Once sent, no wait, and no timer armed per call.
      grant(x);
      await vi.advanceTimersByTimeAsync(0);
      let now = false;
      void x.scopesKnown().then(() => (now = true));
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(now).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("check: hotePermis reads the tab's address, estOnglet a WebAiOs tab only (never the parking tab)", async () => {
    const x = await load({
      1: { attrs: ["webaios-tab-id"], url: "https://hote.test/a" },
      2: { attrs: ["webaios-tab-id"], url: "https://autre.test/" },
      3: { attrs: ["webaios-tab-id", "webaios-parking"], url: "about:blank" },
      4: { attrs: [], url: "https://hote.test/b" },
    });
    grant(x);
    expect([1, 2, 4, 99, "1"].map((t) => x.check(ID, "hotePermis", t))).toEqual([true, false, true, false, false]);
    expect([1, 2, 3, 4, 99].map((t) => x.check(ID, "estOnglet", t))).toEqual([true, true, false, false, false]);
  });

  it("check: estOnglet is false in a private space; a tab the agent cannot read sends extensions.aTourne once per profile", async () => {
    const requests: unknown[][] = [];
    const tab = { attrs: ["webaios-tab-id"], url: "https://hote.test/a" };
    const x = await load({ 1: tab, 2: tab, 5: tab }, { read: ["onglet-1"], requests });
    grant(x);
    expect(x.check(ID, "estOnglet", 5)).toBe(false);
    expect(x.check(ID, "estOnglet", 1)).toBe(true);
    expect(requests).toEqual([]);
    expect(x.check(ID, "estOnglet", 2)).toBe(true);
    expect(x.check(ID, "estOnglet", 2)).toBe(true);
    expect(requests).toEqual([["extensions.aTourne", { addonId: ID, profile: "defaut", readable: false }]]);
  });

  it("check: estOnglet is false in a profile where the extension is not active, or in a container not its space's", async () => {
    const x = await load({ 1: { attrs: ["webaios-tab-id"], url: "https://hote.test/a" }, 2: { attrs: ["webaios-tab-id"], url: "https://hote.test/a", ctx: 3 }, 6: { attrs: ["webaios-tab-id"], url: "https://hote.test/a" } });
    grant(x);
    expect([1, 2, 6].map((t) => x.check(ID, "estOnglet", t))).toEqual([true, false, false]);
  });

  it("extensions.rechargerOnglets reloads, once, the tabs of those profiles its scripts were let into, even after a navigation", async () => {
    const tab3: FakeTab = { attrs: ["webaios-tab-id"], url: "https://hote.test/c" };
    const x = await load({ 1: { attrs: ["webaios-tab-id"], url: "https://hote.test/a" }, 2: { attrs: ["webaios-tab-id"], url: "https://hote.test/b" }, 3: tab3, 4: { attrs: ["webaios-tab-id"], url: "https://hote.test/d" } });
    grant(x);
    for (const t of [1, 3, 4]) x.check(ID, "estOnglet", t);
    tab3.doc = 2;
    const reload = (p: unknown) => x.handlers["extensions.reloadTabs"]!(p, new AbortController().signal);
    reload({ addonId: "autre@agent.webaios", profiles: ["defaut"] });
    expect(reloads).toEqual([]);
    reload({ addonId: ID, profiles: ["defaut"] });
    expect(reloads).toEqual([1, 3, 4]);
    reload({ addonId: ID, profiles: ["defaut"] });
    expect(reloads).toEqual([1, 3, 4]);
  });

  it("a profile turned private reloads at once, without the host, every tab an agent script was let into there", async () => {
    const x = await load({ 1: { attrs: ["webaios-tab-id"], url: "https://hote.test/a" }, 2: { attrs: ["webaios-tab-id"], url: "https://hote.test/b" } });
    x.handlers["extensions.scopes"]!(
      { [ID]: { key: "agent:reseau", grant: GRANT, profiles: ["defaut"], active: true }, "autre@agent.webaios": { key: "agent:autre", grant: GRANT, profiles: ["defaut"], active: true } },
      new AbortController().signal,
    );
    x.check(ID, "estOnglet", 1);
    x.check("autre@agent.webaios", "estOnglet", 2);
    // Switched off there since (out of its profiles): its script still runs, the tab reloads all the same.
    grant(x);
    x.setSpaces([{ id: "e1", private: false, profile: "defaut" }, { id: "e2", private: true, profile: "secret" }, { id: "e3", private: false, profile: "autre" }]);
    expect(reloads).toEqual([]);
    x.setSpaces([{ id: "e1", private: true, profile: "defaut" }, { id: "e2", private: true, profile: "secret" }, { id: "e3", private: false, profile: "autre" }]);
    expect(reloads).toEqual([1, 2]);
  });

  it("extensions.profilsPrives is sent when the set of private profiles changes, and at a host start", async () => {
    const notified: unknown[][] = [];
    const x = await load({}, { notified });
    x.setSpaces([{ id: "e1", private: false, profile: "defaut" }, { id: "e2", private: true, profile: "secret" }]);
    expect(notified).toEqual([]);
    x.setSpaces([{ id: "e1", private: true, profile: "defaut" }, { id: "e2", private: true, profile: "secret" }]);
    expect(notified).toEqual([["extensions.profilsPrives", { privateTabs: ["defaut", "secret"] }]]);
    x.hostStarted();
    expect(notified.at(-1)).toEqual(["extensions.profilsPrives", { privateTabs: ["defaut", "secret"] }]);
  });

  it("an agent extension's TabManager never reaches the parking tab nor a private space's tab", async () => {
    const extension = { id: ID, uninstallURL: null, tabManager: { canAccessTab: (_: unknown) => true } };
    const tab = (attrs: string[]) => ({ attrs, url: "https://hote.test/a" });
    await load({ 1: tab(["webaios-tab-id"]), 3: tab(["webaios-tab-id", "webaios-parking"]), 5: tab(["webaios-tab-id"]), 6: tab(["webaios-tab-id"]) }, { running: [extension] });
    const { tabTracker } = (globalThis as any).ChromeUtils.importESModule().ExtensionParent.apiManager.global;
    expect([1, 3, 5, 6].map((id) => extension.tabManager.canAccessTab(tabTracker.getTab(id)))).toEqual([true, false, false, true]);
  });

  it("every request an agent extension loads or starts is checked, whatever its type: a notification icon outside the grant is cancelled", async () => {
    const x = await load();
    // Before the grants: refused.
    expect(request("https://accorde.test/icone.png", { loading: ID, triggering: ID })).toBe(true);
    grant(x);
    // ext-notifications loads iconUrl with the extension as loadingPrincipal (an image, no document, no CSP).
    expect(request("https://autre.test/notif-fuite.png", { loading: ID, triggering: ID })).toBe(true);
    expect(request("https://accorde.test/icone.png", { loading: ID, triggering: ID })).toBe(false);
    // A navigation: no loadingPrincipal, the extension triggers it.
    expect(request("https://autre.test/page", { loading: null, triggering: ID })).toBe(true);
    expect(request("https://hote.test/page", { loading: null, triggering: ID })).toBe(false);
    // Another add-on, a page, a content script (expanded principal: no addonId), the system: not concerned.
    expect(request("https://autre.test/x", { loading: "autre@webaios.test", triggering: "autre@webaios.test" })).toBe(false);
    expect(request("https://autre.test/x", { loading: "", triggering: "" })).toBe(false);
    expect(request("https://autre.test/x", { loading: null, triggering: undefined })).toBe(false);
  });
});
