import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ID = "reseau@agent.webaios";
const ACCORD = { permissions: [], hotes: ["https://hote.test/*"], reseau: ["accorde.test"], tousLesSites: false, scriptsTousLesSites: false, scripts: false };
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

/** The chrome module with Firefox simulated: one policy (ID → HOST), tabs by id with their attributes and address. */
async function load(tabs: Record<number, { attrs: string[]; url: string }> = {}, o: { lecture?: string[]; requests?: unknown[][] } = {}) {
  vi.stubGlobal("ChromeUtils", {
    importESModule: () => ({
      AddonManager: { addAddonListener: () => {} },
      FileUtils: {},
      ExtensionParent: {
        ParentAPIManager: parentApi,
        apiManager: {
          on: () => {},
          global: {
            tabTracker: {
              getTab: (id: number) => {
                const t = tabs[id];
                if (!t) throw new Error(`Invalid tab ID: ${id}`);
                return {
                  hasAttribute: (a: string) => t.attrs.includes(a),
                  getAttribute: (a: string) => (t.attrs.includes(a) ? `onglet-${id}` : null),
                  linkedBrowser: { currentURI: { spec: t.url } },
                };
              },
            },
          },
        },
      },
    }),
  });
  vi.stubGlobal("WebExtensionPolicy", { getByID: (id: string) => (id === ID ? { mozExtensionHostname: HOST } : null), getActiveExtensions: () => [] });
  vi.stubGlobal("Ci", { nsIHttpChannel: {} });
  vi.stubGlobal("Cr", { NS_BINDING_ABORTED: 0x804b0002 });
  vi.stubGlobal("Services", { obs: { addObserver: (o: (s: unknown) => void, topic: string) => topic === "http-on-modify-request" && (observer = o) } });
  const { createAgentExtensions } = await import("../chrome/store/agent-extensions");
  // WebAiOs tabs onglet-<n>: 5 is in a private space, the others in the default one.
  const espaces = [
    { id: "e1", prive: false, profil: "defaut" },
    { id: "e2", prive: true, profil: "secret" },
  ];
  const onglets = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`onglet-${n}`, { id: `onglet-${n}`, espaceId: n === 5 ? "e2" : "e1" }]));
  const store = { state: { espaces, onglets } };
  const access = () => ({ agent: "L'agent", onglets: Object.fromEntries((o.lecture ?? []).map((id) => [id, { lecture: true, droits: [], construite: false, enCours: false }])) });
  const host = { request: (...a: unknown[]) => (o.requests?.push(a), Promise.resolve()) };
  const x = createAgentExtensions(store as never, {} as never, {} as never, () => host as never, access as never);
  return x;
}
const grant = (x: Awaited<ReturnType<typeof load>>, actif = true) =>
  x.handlers["extensions.portees"]!({ [ID]: { cle: "agent:reseau", accord: ACCORD, profils: ["defaut"], actif } }, new AbortController().signal);

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
    const x = await load({ 1: tab, 2: tab, 5: tab }, { lecture: ["onglet-1"], requests });
    grant(x);
    expect(x.check(ID, "estOnglet", 5)).toBe(false);
    expect(x.check(ID, "estOnglet", 1)).toBe(true);
    expect(requests).toEqual([]);
    expect(x.check(ID, "estOnglet", 2)).toBe(true);
    expect(x.check(ID, "estOnglet", 2)).toBe(true);
    expect(requests).toEqual([["extensions.aTourne", { addonId: ID, profil: "defaut", lisible: false }]]);
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
