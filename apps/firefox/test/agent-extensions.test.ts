import { afterEach, describe, expect, it, vi } from "vitest";

const ID = "reseau@agent.webaios";
const ACCORD = { permissions: [], hotes: ["https://hote.test/*"], reseau: ["accorde.test"], tousLesSites: false, scriptsTousLesSites: false, scripts: false };
const HOST = "0f7c6f4e-1111-4222-8333-444455556666";

/** The chrome module with Firefox simulated: one policy (ID → HOST), tabs by id with their attributes and address. */
async function load(tabs: Record<number, { attrs: string[]; url: string }> = {}) {
  vi.stubGlobal("ChromeUtils", {
    importESModule: () => ({
      AddonManager: { addAddonListener: () => {} },
      FileUtils: {},
      ExtensionParent: {
        apiManager: {
          on: () => {},
          global: {
            tabTracker: {
              getTab: (id: number) => {
                const t = tabs[id];
                if (!t) throw new Error(`Invalid tab ID: ${id}`);
                return { hasAttribute: (a: string) => t.attrs.includes(a), linkedBrowser: { currentURI: { spec: t.url } } };
              },
            },
          },
        },
      },
    }),
  });
  vi.stubGlobal("WebExtensionPolicy", { getByID: (id: string) => (id === ID ? { mozExtensionHostname: HOST } : null), getActiveExtensions: () => [] });
  vi.stubGlobal("Ci", { nsIContentPolicy: { TYPE_DOCUMENT: 6, TYPE_SUBDOCUMENT: 7 } });
  vi.stubGlobal("Services", { obs: { addObserver: () => {} } });
  const { createAgentExtensions } = await import("../chrome/store/agent-extensions");
  const x = createAgentExtensions({} as never, {} as never, {} as never, () => ({}) as never);
  return x;
}
const grant = (x: Awaited<ReturnType<typeof load>>, actif = true) =>
  x.handlers["extensions.portees"]!({ [ID]: { cle: "agent:reseau", accord: ACCORD, profils: ["defaut"], actif } }, new AbortController().signal);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("agent extension checkpoints", () => {
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

  it("check: nothing passes before the grants are known", async () => {
    const x = await load();
    expect(x.check(ID, "urlPermise", "https://accorde.test/")).toBe(false);
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
});
