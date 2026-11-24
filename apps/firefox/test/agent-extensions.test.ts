import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ID = "reseau@agent.ressac";
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
type FakeFrame = { id: number; url: string; parent?: number; principal?: string };
type FakeTab = { attrs: string[]; url: string; ctx?: number; doc?: number; frames?: FakeFrame[] };
/** A BrowsingContext as the parent sees it: its id, its document's address and principal, its parent. */
const context = (id: number, url: string, principal = url, parent: unknown = null) => ({ id, parent, currentWindowGlobal: { documentURI: { spec: url }, documentPrincipal: { URI: { spec: principal } } } });
/** The tab's frame tree: its top, then each frame under its `parent` (default the top). */
const tree = (id: number, t: FakeTab) => {
  const top = context(100 + id, t.url);
  const all: Record<number, ReturnType<typeof context>> = { [top.id]: top };
  for (const f of t.frames ?? []) all[f.id] = context(f.id, f.url, f.principal ?? f.url, all[f.parent ?? top.id]);
  return Object.assign(top, { getAllBrowsingContextsInSubtree: () => Object.values(all) });
};
const tabElements = new Map<number, unknown>();
const tabElement = (id: number, t: FakeTab) => {
  if (!tabElements.has(id))
    tabElements.set(id, {
      hasAttribute: (a: string) => t.attrs.includes(a),
      getAttribute: (a: string) => (t.attrs.includes(a) ? `tab-${id}` : null),
      userContextId: t.ctx ?? 0,
      isConnected: true,
      linkedBrowser: {
        currentURI: { spec: t.url },
        get innerWindowID() { return t.doc ?? 1; },
        reload: () => reloads.push(id),
        browsingContext: tree(id, t),
      },
    });
  return tabElements.get(id);
};

/** An installed add-on as AddonManager lists it; `uninstalled` once uninstall() ran. */
type FakeAddon = { id: string; uninstalled?: boolean; uninstall(): Promise<void>; userDisabled?: boolean; enable?(): Promise<void>; disable?(): Promise<void> };

/** Boolean prefs in `values`, with their observers (by branch) called on each write, as Firefox does. */
function fakePrefs(values: Record<string, boolean>) {
  const observers: [string, (s: unknown, t: string, pref: string) => void][] = [];
  return {
    getBoolPref: (n: string, d = false) => values[n] ?? d,
    setBoolPref: (n: string, v: boolean) => {
      values[n] = v;
      for (const [branch, f] of observers) if (n.startsWith(branch)) f(null, "nsPref:changed", n);
    },
    getChildList: (branch: string) => Object.keys(values).filter((n) => n.startsWith(branch)),
    addObserver: (branch: string, f: (s: unknown, t: string, pref: string) => void) => void observers.push([branch, f]),
  };
}

/** The chrome module with Firefox simulated: one policy (ID → HOST), tabs by id with their attributes and address. */
async function load(
  tabs: Record<number, FakeTab> = {},
  o: { read?: string[]; requests?: unknown[][]; notified?: unknown[][]; running?: unknown[]; addons?: FakeAddon[]; prefs?: Record<string, string>; boolPrefs?: Record<string, boolean>; passportsKnown?: false } = {},
) {
  reloads.length = 0;
  tabElements.clear();
  vi.stubGlobal("ChromeUtils", {
    importESModule: () => ({
      AddonManager: { addAddonListener: () => {}, getAddonsByTypes: async () => o.addons ?? [], getAddonByID: async (id: string) => o.addons?.find((a) => a.id === id) ?? null },
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
  vi.stubGlobal("Services", { obs: { addObserver: (o: (s: unknown) => void, topic: string) => topic === "http-on-modify-request" && (observer = o) }, console: { registerListener: () => {} }, env: { get: () => "" }, prefs: { ...fakePrefs(o.boolPrefs ?? {}), getStringPref: (n: string, d: string) => o.prefs?.[n] ?? d, setStringPref: (n: string, v: string) => o.prefs && (o.prefs[n] = v) } });
  const { createAgentExtensions } = await import("../chrome/store/agent-extensions");
  // The chrome pushed its passports (none here): the passport hosts are known.
  if (o.passportsKnown !== false) (await import("../chrome/passport/hosts")).passportHostsKnown();
  // Ressac tabs onglet-<n>: 5 is in a private space, 6 in another profile's, the others in the default one.
  const spaces = [
    { id: "e1", private: false, profile: "default" },
    { id: "e2", private: true, profile: "secret" },
    { id: "e3", private: false, profile: "autre" },
  ];
  const tabMap = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`tab-${n}`, { id: `tab-${n}`, spaceId: n === 5 ? "e2" : n === 6 ? "e3" : "e1" }]));
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
  x.handlers["extensions.scopes"]!({ [ID]: { key: "agent:reseau", grant: GRANT, profiles: ["default"], active: active } }, new AbortController().signal);

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
    expect(parentApi.sent[0]).toEqual({ childId: 1, callId: 7, path: "tabs.captureVisibleTab", error: { message: "tabs.captureVisibleTab non pris en charge par Ressac" } });
  });

  it("check: urlAllowed accepts its own moz-extension host and a granted network domain only", async () => {
    const x = await load();
    grant(x);
    const ok = (v: unknown) => x.check(ID, "urlAllowed", v);
    expect(ok(`moz-extension://${HOST}/page.html`)).toBe(true);
    expect(ok("page.html")).toBe(true);
    expect(ok("https://accorde.test/x")).toBe(true);
    expect(ok("https://hote.test/x")).toBe(true);
    for (const refused of ["data:text/html,x", "javascript:alert(1)", "moz-extension://autre-hote/page.html", "https://autre.test/", "https://u:p@accorde.test/", 42, null])
      expect(ok(refused)).toBe(false);
    // Not granted, not active, or not answered yet: nothing passes.
    expect(x.check("autre@agent.ressac", "urlAllowed", "https://accorde.test/")).toBe(false);
    grant(x, false);
    expect(ok("https://accorde.test/")).toBe(false);
  });

  it("check: nothing passes before the grants are known; a checkpoint waits for them at most SCOPES_WAIT_MS", async () => {
    const x = await load();
    expect(x.check(ID, "urlAllowed", "https://accorde.test/")).toBe(false);
    vi.useFakeTimers();
    try {
      let waited = false;
      void x.scopesKnown().then(() => (waited = true));
      await vi.advanceTimersByTimeAsync(4_900);
      expect(waited).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(waited).toBe(true);
      expect(x.check(ID, "urlAllowed", "https://accorde.test/")).toBe(false);
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

  it("check: hostAllowed reads the tab's address, isTab a Ressac tab only (never the parking tab)", async () => {
    const x = await load({
      1: { attrs: ["ressac-tab-id"], url: "https://hote.test/a" },
      2: { attrs: ["ressac-tab-id"], url: "https://autre.test/" },
      3: { attrs: ["ressac-tab-id", "ressac-parking"], url: "about:blank" },
      4: { attrs: [], url: "https://hote.test/b" },
    });
    grant(x);
    expect([1, 2, 4, 99, "1"].map((t) => x.check(ID, "hostAllowed", t))).toEqual([true, false, true, false, false]);
    expect([1, 2, 3, 4, 99].map((t) => x.check(ID, "isTab", `${t}:0`))).toEqual([true, true, false, false, false]);
  });

  it("check: isTab is false in a private space; a tab the agent cannot read sends extensions.aTourne once per profile", async () => {
    const requests: unknown[][] = [];
    const tab = { attrs: ["ressac-tab-id"], url: "https://hote.test/a" };
    const x = await load({ 1: tab, 2: tab, 5: tab }, { read: ["tab-1"], requests });
    grant(x);
    expect(x.check(ID, "isTab", "5:0")).toBe(false);
    expect(x.check(ID, "isTab", "1:0")).toBe(true);
    expect(requests).toEqual([]);
    expect(x.check(ID, "isTab", "2:0")).toBe(true);
    expect(x.check(ID, "isTab", "2:0")).toBe(true);
    expect(requests).toEqual([["extensions.ran", { addonId: ID, profile: "default", readable: false }]]);
  });

  it("check: isTab is false in a profile where the extension is not active, or in a container not its space's", async () => {
    const x = await load({ 1: { attrs: ["ressac-tab-id"], url: "https://hote.test/a" }, 2: { attrs: ["ressac-tab-id"], url: "https://hote.test/a", ctx: 3 }, 6: { attrs: ["ressac-tab-id"], url: "https://hote.test/a" } });
    grant(x);
    expect([1, 2, 6].map((t) => x.check(ID, "isTab", `${t}:0`))).toEqual([true, false, false]);
  });

  it("extensions.rechargerOnglets reloads, once, the tabs of those profiles its scripts were let into, even after a navigation", async () => {
    const tab3: FakeTab = { attrs: ["ressac-tab-id"], url: "https://hote.test/c" };
    const x = await load({ 1: { attrs: ["ressac-tab-id"], url: "https://hote.test/a" }, 2: { attrs: ["ressac-tab-id"], url: "https://hote.test/b" }, 3: tab3, 4: { attrs: ["ressac-tab-id"], url: "https://hote.test/d" } });
    grant(x);
    for (const t of [1, 3, 4]) x.check(ID, "isTab", `${t}:0`);
    tab3.doc = 2;
    const reload = (p: unknown) => x.handlers["extensions.reloadTabs"]!(p, new AbortController().signal);
    reload({ addonId: "autre@agent.ressac", profiles: ["default"] });
    expect(reloads).toEqual([]);
    reload({ addonId: ID, profiles: ["default"] });
    expect(reloads).toEqual([1, 3, 4]);
    reload({ addonId: ID, profiles: ["default"] });
    expect(reloads).toEqual([1, 3, 4]);
  });

  it("a profile turned private reloads at once, without the host, every tab an agent script was let into there", async () => {
    const x = await load({ 1: { attrs: ["ressac-tab-id"], url: "https://hote.test/a" }, 2: { attrs: ["ressac-tab-id"], url: "https://hote.test/b" } });
    x.handlers["extensions.scopes"]!(
      { [ID]: { key: "agent:reseau", grant: GRANT, profiles: ["default"], active: true }, "autre@agent.ressac": { key: "agent:autre", grant: GRANT, profiles: ["default"], active: true } },
      new AbortController().signal,
    );
    x.check(ID, "isTab", "1:0");
    x.check("autre@agent.ressac", "isTab", "2:0");
    // Switched off there since (out of its profiles): its script still runs, the tab reloads all the same.
    grant(x);
    x.setSpaces([{ id: "e1", private: false, profile: "default" }, { id: "e2", private: true, profile: "secret" }, { id: "e3", private: false, profile: "autre" }]);
    expect(reloads).toEqual([]);
    x.setSpaces([{ id: "e1", private: true, profile: "default" }, { id: "e2", private: true, profile: "secret" }, { id: "e3", private: false, profile: "autre" }]);
    expect(reloads).toEqual([1, 2]);
  });

  it("extensions.profilsPrives is sent when the set of private profiles changes, and at a host start", async () => {
    const notified: unknown[][] = [];
    const x = await load({}, { notified });
    x.setSpaces([{ id: "e1", private: false, profile: "default" }, { id: "e2", private: true, profile: "secret" }]);
    expect(notified).toEqual([]);
    x.setSpaces([{ id: "e1", private: true, profile: "default" }, { id: "e2", private: true, profile: "secret" }]);
    expect(notified).toEqual([["extensions.privateProfiles", { profiles: ["default", "secret"] }]]);
    x.hostStarted();
    expect(notified.at(-1)).toEqual(["extensions.privateProfiles", { profiles: ["default", "secret"] }]);
  });

  it("hostAllowed: a sensitive page the exact-host quarantine misses is refused on its first visit (a subdomain, a path)", async () => {
    const x = await load({
      1: { attrs: ["ressac-tab-id"], url: "https://app.qonto.com/" },
      2: { attrs: ["ressac-tab-id"], url: "https://hote.test/compte/releve" },
      3: { attrs: ["ressac-tab-id"], url: "https://hote.test/a" },
    });
    const grant = { ...GRANT, hosts: ["https://app.qonto.com/*", "https://hote.test/*"] };
    x.handlers["extensions.scopes"]!({ [ID]: { key: "agent:reseau", grant, profiles: ["default"], active: true } }, new AbortController().signal);
    expect([1, 2, 3].map((t) => x.check(ID, "hostAllowed", t))).toEqual([false, false, true]);
  });

  it("hostAllowed and urlAllowed: a passport host and its www. are refused while a passport holds them, allowed once it leaves", async () => {
    const x = await load({
      1: { attrs: ["ressac-tab-id"], url: "https://hote.test/b" },
      2: { attrs: ["ressac-tab-id"], url: "https://www.hote.test/a" },
      3: { attrs: ["ressac-tab-id"], url: "https://autre.hote.test/a" },
    });
    const { setPassportHosts } = await import("../chrome/passport/hosts");
    x.handlers["extensions.scopes"]!({ [ID]: { key: "agent:reseau", grant: { ...GRANT, hosts: ["https://*.hote.test/*", "https://hote.test/*"], network: ["hote.test", "www.hote.test"] }, profiles: ["default"], active: true } }, new AbortController().signal);
    const allowed = () => [...[1, 2, 3].map((t) => x.check(ID, "hostAllowed", t)), x.check(ID, "urlAllowed", "https://hote.test/x"), x.check(ID, "urlAllowed", "https://www.hote.test/x")];
    expect(allowed()).toEqual([true, true, true, true, true]);
    setPassportHosts("perso", [{ origins: ["hote.test"] }]);
    expect(allowed()).toEqual([false, false, true, false, false]);
    setPassportHosts("perso", []);
    expect(allowed()).toEqual([true, true, true, true, true]);
  });

  it("before the passports are known, every host counts as a passport's: hostAllowed, urlAllowed and isTab refuse", async () => {
    const x = await load({ 1: { attrs: ["ressac-tab-id"], url: "https://hote.test/b" } }, { passportsKnown: false });
    grant(x);
    expect([x.check(ID, "hostAllowed", 1), x.check(ID, "urlAllowed", "https://accorde.test/"), x.check(ID, "isTab", "1:0")]).toEqual([false, false, false]);
    (await import("../chrome/passport/hosts")).passportHostsKnown();
    expect([x.check(ID, "hostAllowed", 1), x.check(ID, "urlAllowed", "https://accorde.test/"), x.check(ID, "isTab", "1:0")]).toEqual([true, true, true]);
  });

  it("isTab: a frame on a passport host is refused like a sensitive one, by its own document", async () => {
    const x = await load({ 1: { attrs: ["ressac-tab-id"], url: "https://hote.test/a", frames: [{ id: 7, url: "https://banque.test/x" }, { id: 9, url: "https://pub.test/x" }] } });
    grant(x);
    (await import("../chrome/passport/hosts")).setPassportHosts("perso", [{ origins: ["banque.test"] }]);
    expect(["1:7", "1:9", "1:*"].map((v) => x.check(ID, "isTab", v))).toEqual([false, true, false]);
  });

  it("isTab: a sensitive frame in an ordinary tab is refused, by its own document; `*` refuses if any frame is", async () => {
    const x = await load({
      1: { attrs: ["ressac-tab-id"], url: "https://hote.test/a", frames: [{ id: 7, url: "https://accounts.hote.test/signin" }, { id: 8, url: "https://app.qonto.com/" }, { id: 9, url: "https://pub.test/x" }] },
      2: { attrs: ["ressac-tab-id"], url: "https://hote.test/b", frames: [{ id: 9, url: "https://pub.test/x" }] },
      3: { attrs: ["ressac-tab-id"], url: "https://mail.google.com/", frames: [{ id: 9, url: "https://pub.test/x" }] },
    });
    grant(x);
    // The manifest/registered scripts' path (the sender's frame) and executeScript's frameIds ask the same way.
    expect(["1:7", "1:8", "1:9", "1:0", "1:*", "2:*", "2:9", "3:9", "1:99", "1", "x:0"].map((v) => x.check(ID, "isTab", v))).toEqual([
      false, false, true, true, false, true, true, false, false, false, false,
    ]);
    // A copy signed before this guard sends a bare tab id and checks no frame: refused until it is signed again.
    expect([1, 3].map((v) => x.check(ID, "isTab", v))).toEqual([false, false]);
  });

  it("isTab: a blank child of a sensitive iframe is refused (same origin: it reads its parent), by each frame's principal up to the top", async () => {
    const x = await load({
      1: { attrs: ["ressac-tab-id"], url: "https://hote.test/a", frames: [
        { id: 7, url: "https://accounts.hote.test/signin" },
        { id: 70, url: "about:blank", parent: 7, principal: "https://accounts.hote.test/signin" },
        { id: 71, url: "about:srcdoc", parent: 7, principal: "https://pub.test/x" },
        { id: 9, url: "https://pub.test/x" },
        { id: 90, url: "about:blank", parent: 9 },
      ] },
    });
    grant(x);
    expect(["1:70", "1:71", "1:90", "1:9"].map((v) => x.check(ID, "isTab", v))).toEqual([false, false, true, true]);
  });

  it("an agent extension's TabManager never reaches a sensitive tab: its address and title stay out of tabs and webNavigation", async () => {
    const extension = { id: ID, uninstallURL: null, tabManager: { canAccessTab: (_: unknown) => true } };
    await load({ 1: { attrs: ["ressac-tab-id"], url: "https://mail.google.com/mail/u/0/" }, 2: { attrs: ["ressac-tab-id"], url: "https://hote.test/settings" }, 3: { attrs: ["ressac-tab-id"], url: "https://hote.test/a" } }, { running: [extension] });
    const { tabTracker } = (globalThis as any).ChromeUtils.importESModule().ExtensionParent.apiManager.global;
    expect([1, 2, 3].map((id) => extension.tabManager.canAccessTab(tabTracker.getTab(id)))).toEqual([false, false, true]);
  });

  it("an agent extension's TabManager never reaches a tab on a passport host: its address and title stay out", async () => {
    const extension = { id: ID, uninstallURL: null, tabManager: { canAccessTab: (_: unknown) => true } };
    await load({ 1: { attrs: ["ressac-tab-id"], url: "https://www.banque.test/a" }, 2: { attrs: ["ressac-tab-id"], url: "https://hote.test/a" } }, { running: [extension] });
    (await import("../chrome/passport/hosts")).setPassportHosts("perso", [{ origins: ["banque.test"] }]);
    const { tabTracker } = (globalThis as any).ChromeUtils.importESModule().ExtensionParent.apiManager.global;
    expect([1, 2].map((id) => extension.tabManager.canAccessTab(tabTracker.getTab(id)))).toEqual([false, true]);
  });

  it("an agent extension's TabManager never reaches the parking tab nor a private space's tab", async () => {
    const extension = { id: ID, uninstallURL: null, tabManager: { canAccessTab: (_: unknown) => true } };
    const tab = (attrs: string[]) => ({ attrs, url: "https://hote.test/a" });
    await load({ 1: tab(["ressac-tab-id"]), 3: tab(["ressac-tab-id", "ressac-parking"]), 5: tab(["ressac-tab-id"]), 6: tab(["ressac-tab-id"]) }, { running: [extension] });
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
    expect(request("https://autre.test/x", { loading: "autre@ressac.test", triggering: "autre@ressac.test" })).toBe(false);
    expect(request("https://autre.test/x", { loading: "", triggering: "" })).toBe(false);
    expect(request("https://autre.test/x", { loading: null, triggering: undefined })).toBe(false);
  });
});

describe("agent extensions and Firefox's quarantine (masking, Task 15)", () => {
  const EXEMPT = `extensions.quarantineIgnoredByUser.${ID}`;
  const addon = (): FakeAddon => ({ id: ID, uninstall: async () => {}, userDisabled: true, enable: async () => {}, disable: async () => {} });

  it("a user exemption from quarantine never holds for an agent extension: reset at startup, on each change, on each evaluation", async () => {
    const boolPrefs: Record<string, boolean> = { [EXEMPT]: true, "extensions.quarantineIgnoredByUser.autre@mozilla.org": true };
    const x = await load({}, { boolPrefs, addons: [addon()] });
    // At startup: the agent's is reset, another add-on's is the user's to keep.
    expect(boolPrefs[EXEMPT]).toBe(false);
    expect(boolPrefs["extensions.quarantineIgnoredByUser.autre@mozilla.org"]).toBe(true);
    // about:addons sets it while it runs: reset at once.
    Services.prefs.setBoolPref(EXEMPT, true);
    expect(boolPrefs[EXEMPT]).toBe(false);
    // Each evaluation (extensions.enable) resets it too, whatever set it.
    boolPrefs[EXEMPT] = true;
    await x.handlers["extensions.enable"]!({ addonId: ID, active: true }, new AbortController().signal);
    expect(boolPrefs[EXEMPT]).toBe(false);
  });
});

describe("agent extensions: Navigateur and the workspace lock (masking, Task 15)", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("extensionsAllowed: only in Atelier, with the lock file absent; unreadable reads as locked", async () => {
    const { extensionsAllowed } = await import("../host/extensions/agent");
    const { WorkspaceLock } = await import("../../../packages/kernel/src/index.ts");
    const folder = mkdtempSync(join(tmpdir(), "ressac-lock-"));
    dirs.push(folder);
    const lock = new WorkspaceLock(join(folder, "lock.json"));
    expect(extensionsAllowed("browser", lock)).toBe(false);
    expect(extensionsAllowed("workshop", lock)).toBe(true);
    await lock.lock({ names: ["votre code"] });
    expect(extensionsAllowed("workshop", lock)).toBe(false);
    await lock.lift();
    expect(extensionsAllowed("workshop", lock)).toBe(true);
    // A file that cannot be read (a folder in its place): the lock state is unknown, fail closed.
    mkdirSync(join(folder, "lock.json"));
    expect(extensionsAllowed("workshop", lock)).toBe(false);
  });

  it("not allowed: the granted extension is disabled and its scope inactive; allowed again (a lift in Atelier): enabled", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ressac-ext-"));
    dirs.push(folder);
    const entry = { source: "agent", addonId: null, name: "reseau", version: "1.0.0", grant: GRANT, profiles: ["default"], pinned: false, modifiedAt: null, disabled: null, pendingUpdate: null, seenVersions: {} };
    writeFileSync(join(folder, "state.json"), JSON.stringify({ version: 1, allCut: false, extensions: { "agent:reseau": entry } }));
    const requests: [string, unknown][] = [];
    const notified: [string, unknown][] = [];
    const rpc = {
      request: async (m: string, p: unknown) => (requests.push([m, p]), m === "browser.spaces" ? { spaces: [], windows: [], foreground: null } : null),
      notify: (m: string, p?: unknown) => void notified.push([m, p]),
    };
    let allowed = false;
    let changes = 0;
    const { ExtensionsAgent } = await import("../host/extensions/agent");
    const x = new ExtensionsAgent({ folder, agentFolder: join(folder, "agent"), rpc: rpc as never, allowed: () => allowed, onScopes: () => changes++ });
    const enables = () => requests.filter(([m]) => m === "extensions.enable").map(([, p]) => (p as { active: boolean }).active);
    const lastScope = () => (notified.filter(([m]) => m === "extensions.scopes").at(-1)![1] as Record<string, { active: boolean }>)[ID]!.active;

    // Before start: start applies them all itself.
    await x.reevaluate();
    expect(notified).toEqual([]);
    // Its folder is gone, so start disables it anyway; the scope sent first says inactive.
    await x.start();
    expect(enables()).toEqual([false]);
    expect(lastScope()).toBe(false);
    expect(await x.running()).toBe(false);
    expect(changes).toBe(1);
    // Nothing changed: nothing applied again.
    await x.reevaluate();
    expect(enables()).toEqual([false]);

    allowed = true;
    await x.reevaluate();
    expect(enables()).toEqual([false, true]);
    expect(lastScope()).toBe(true);
    expect(await x.running()).toBe(true);
    expect(changes).toBe(2);
  });

  it("reevaluate: one key held (an open grant card) does not keep the others enabled under a lock", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ressac-ext-"));
    dirs.push(folder);
    const entry = { source: "agent", addonId: null, version: "1.0.0", grant: GRANT, profiles: ["default"], pinned: false, modifiedAt: null, disabled: null, pendingUpdate: null, seenVersions: {} };
    writeFileSync(join(folder, "state.json"), JSON.stringify({ version: 1, allCut: false, extensions: { "agent:tenue": { ...entry, name: "tenue" }, "agent:libre": { ...entry, name: "libre" } } }));
    const enables: { addonId: string; active: boolean }[] = [];
    const rpc = {
      request: async (m: string, p: unknown) => (m === "extensions.enable" && enables.push(p as never), m === "browser.spaces" ? { spaces: [], windows: [], foreground: null } : null),
      notify: () => {},
    };
    let allowed = true;
    const { ExtensionsAgent } = await import("../host/extensions/agent");
    const x = new ExtensionsAgent({ folder, agentFolder: join(folder, "agent"), rpc: rpc as never, allowed: () => allowed });
    await x.start();
    enables.length = 0;
    // A grant card holds tenue's queue.
    let release = () => {};
    void (x as unknown as { queued(k: string, f: () => Promise<void>): Promise<void> }).queued("agent:tenue", () => new Promise<void>((r) => (release = r)));
    allowed = false;
    const done = x.reevaluate();
    await expect.poll(() => enables).toEqual([{ addonId: "libre@agent.ressac", active: false }]);
    // A second call (the reveal's, awaited) returns only once the first one has applied, not as soon as it sees nothing new.
    let second = false;
    void x.reevaluate().then(() => (second = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(second).toBe(false);
    release();
    await done;
    expect(enables).toContainEqual({ addonId: "tenue@agent.ressac", active: false });
    await expect.poll(() => second).toBe(true);
  });
});

describe("Firefox's quarantined domains (masking, Task 15)", () => {
  const LIST = "extensions.quarantinedDomains.list";
  const ENABLED = "extensions.quarantinedDomains.enabled";
  /** Firefox's prefs: strings and booleans, observers called on each write. */
  const prefs = (strings: Record<string, string>, bools: Record<string, boolean>) => {
    const observers: [string, () => void][] = [];
    const changed = (n: string) => observers.filter(([b]) => n.startsWith(b)).forEach(([, f]) => f());
    return {
      getStringPref: (n: string, d = "") => strings[n] ?? d,
      setStringPref: (n: string, v: string) => ((strings[n] = v), changed(n)),
      getBoolPref: (n: string, d = false) => bools[n] ?? d,
      setBoolPref: (n: string, v: boolean) => ((bools[n] = v), changed(n)),
      addObserver: (b: string, f: () => void) => void observers.push([b, f]),
    };
  };

  it("quarantineHosts: the static sensitive list with its www., nothing else", async () => {
    const { quarantineHosts } = await import("../chrome/store/quarantine");
    const hosts = quarantineHosts();
    expect(hosts).toEqual(expect.arrayContaining(["mail.google.com", "www.mail.google.com", "revolut.com", "www.revolut.com"]));
    expect(hosts).not.toContain("");
  });

  it("installQuarantine: enabled, the user's own entries kept once, under Gecko's 4096-character limit, put back if edited", async () => {
    const strings = { [LIST]: "a-moi.test, mail.google.com" };
    const bools = { [ENABLED]: false };
    vi.stubGlobal("Services", { prefs: prefs(strings, bools) });
    const { installQuarantine } = await import("../chrome/store/quarantine");
    installQuarantine();
    const list = () => strings[LIST]!.split(",");
    expect(bools[ENABLED]).toBe(true);
    expect(list()).toContain("a-moi.test");
    expect(list().filter((h) => h === "mail.google.com")).toHaveLength(1);
    expect(list()).toContain("www.revolut.com");
    // Past 4096 characters, Gecko does not send a string pref to content processes: the quarantine there would be empty.
    expect(strings[LIST]!.length).toBeLessThan(4096);

    // Someone empties the list or turns quarantine off: put back at once.
    Services.prefs.setStringPref(LIST, "autre-a-moi.test");
    expect(list()).toEqual(expect.arrayContaining(["autre-a-moi.test", "mail.google.com"]));
    Services.prefs.setBoolPref(ENABLED, false);
    expect(bools[ENABLED]).toBe(true);
  });
});
