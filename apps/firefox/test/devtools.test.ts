import { expect, it } from "vitest";
import { etatInitial } from "../../navigateur/src/main/etat/etat-initial";
import { TEXTE_REVOQUE } from "../../navigateur/src/main/outils-dev/inspecteur";
import { createDevTools } from "../chrome/store/devtools";
import { createStore } from "../chrome/store/store";
import type { WindowRegistry } from "../chrome/store/windows";

/** Fake DevTools clients (CommandsFactory.forTab): their top-level target is destroyed, as right after a navigation,
 * unless a test sets `liveTarget`. */
const clients: { destroyed: boolean }[] = [];
let liveTarget: unknown = null;
(globalThis as any).ChromeUtils = {
  importESModule: () => ({
    require: () => ({
      CommandsFactory: {
        forTab: async () => {
          const c = {
            destroyed: false,
            targetCommand: { TYPES: { FRAME: "frame" }, startListening: async () => {}, watchTargets: async () => {}, targetFront: liveTarget ?? { isDestroyed: () => true } },
            resourceCommand: { TYPES: { CONSOLE_MESSAGE: "c", ERROR_MESSAGE: "e", NETWORK_EVENT: "n", DOCUMENT_EVENT: "d" }, watchResources: async () => {} },
            scriptCommand: { execute: async () => ({ result: 1 }) },
            destroy: async () => void (c.destroyed = true),
          };
          clients.push(c);
          return c;
        },
      },
    }),
  }),
};

/** A store with tab "t"; `ensure` gives the tab's browser (rejects by default: no DevTools client then). */
function setup(o: { isPrivate?: boolean; ensure?: (id: string) => Promise<unknown> } = {}) {
  const store = createStore(etatInitial());
  store.dispatch({ type: "ouvrirOnglet", fenetreId: store.state.fenetres[0]!.id, url: "http://127.0.0.1:5300/", activer: true }, () => "t");
  const loaded: string[] = [];
  const ensure = o.ensure ?? (() => Promise.reject(new Error("no browser")));
  const window = { gBrowser: { getTabForBrowser: () => ({}) } };
  const windows = { get: () => ({ window, controller: { ensure: (id: string) => (loaded.push(id), ensure(id)) } }) } as unknown as WindowRegistry;
  return { devtools: createDevTools({ store, windows, isPrivate: () => o.isPrivate ?? false }), loaded };
}
const browserAt = (spec: string) => ({ currentURI: { spec } });

it("a private tab is refused before its page is even looked up", async () => {
  const { devtools, loaded } = setup({ isPrivate: true });
  const { token } = devtools.owner();
  await expect(devtools.call(token, "attacher", ["t"])).rejects.toMatchObject({ name: "OngletPrive", id: "t" });
  await expect(devtools.call(token, "console", ["t"])).rejects.toMatchObject({ name: "OngletPrive" });
  expect(loaded).toEqual([]);
  expect(devtools.attached()).toEqual([]);
});

it("an unknown tab: OngletIntrouvable", async () => {
  const { devtools } = setup();
  await expect(devtools.call(devtools.owner().token, "console", ["gone"])).rejects.toMatchObject({ name: "OngletIntrouvable", id: "gone" });
});

it("a new owner revokes the previous one; a released owner is refused; a method not provided is refused", async () => {
  const { devtools } = setup();
  const first = devtools.owner().token;
  const second = devtools.owner().token;
  await expect(devtools.call(first, "console", ["t"])).rejects.toThrow(TEXTE_REVOQUE);
  await expect(devtools.call(second, "attaches" as never, [])).rejects.toThrow("Pas encore disponible");
  await expect(devtools.call(second, "constructor" as never, [])).rejects.toThrow("Pas encore disponible");
  devtools.release(first); // not the current one: nothing happens
  await expect(devtools.call(second, "console", ["t"])).rejects.toThrow("no browser");
  devtools.release();
  await expect(devtools.call(second, "console", ["t"])).rejects.toThrow(TEXTE_REVOQUE);
});

it("an old owner's call still loading its tab when a new owner comes attaches nothing", async () => {
  let give: (b: unknown) => void = () => {};
  const { devtools } = setup({ ensure: () => new Promise((r) => (give = r)) });
  const before = clients.length;
  const old = devtools.call(devtools.owner().token, "console", ["t"]);
  devtools.owner();
  give(browserAt("http://127.0.0.1:5300/"));
  await expect(old).rejects.toThrow(TEXTE_REVOQUE);
  expect(devtools.attached()).toEqual([]);
  expect(clients.slice(before).every((c) => c.destroyed)).toBe(true);
});

it("the tab on another origin (a navigation not heard): the session is dropped and a new one attached", async () => {
  const browser = browserAt("http://127.0.0.1:5300/");
  const { devtools } = setup({ ensure: async () => browser });
  const { token } = devtools.owner();
  const before = clients.length;
  await devtools.call(token, "console", ["t"]);
  browser.currentURI.spec = "http://localhost:5300/";
  await devtools.call(token, "console", ["t"]);
  expect(clients.length - before).toBe(2);
  await new Promise((r) => setTimeout(r, 0));
  expect(clients[before]!.destroyed).toBe(true);
  expect(clients[before + 1]!.destroyed).toBe(false);
});

it("a call waiting for the page's next target ends as soon as the session is dropped", async () => {
  const { devtools } = setup({ ensure: async () => browserAt("http://127.0.0.1:5300/") });
  const { token } = devtools.owner();
  const t0 = Date.now();
  const run = devtools.call(token, "executer", ["t", "1"]);
  await new Promise((r) => setTimeout(r, 50));
  await devtools.call(token, "detacher", ["t"]);
  await expect(run).rejects.toThrow("détachés");
  expect(Date.now() - t0).toBeLessThan(2000);
});

/** A fake memory front (note D6): takeCensus needs it attached, and takes a while. */
function memoryFront(state: "attached" | "detached") {
  const mem = {
    state: state as string,
    calls: [] as string[],
    getState: async () => mem.state,
    attach: async () => void (mem.calls.push("attach"), (mem.state = "attached")),
    detach: async () => void (mem.calls.push("detach"), (mem.state = "detached")),
    takeCensus: async () => {
      await new Promise((r) => setTimeout(r, 20));
      if (mem.state !== "attached") throw new Error("not attached");
      return { objects: { Object: { count: 2, bytes: 64 } }, strings: { count: 1, bytes: 16 }, scripts: { count: 0, bytes: 0 }, other: {}, domNode: {} };
    },
  };
  return mem;
}

it("instantaneMemoire leaves a memory front attached by someone else (the person's Memory panel) attached", async () => {
  const mem = memoryFront("attached");
  liveTarget = { isDestroyed: () => false, getFront: async () => mem };
  try {
    const { devtools } = setup({ ensure: async () => browserAt("http://127.0.0.1:5300/") });
    const r = JSON.parse(String(await devtools.call(devtools.owner().token, "instantaneMemoire", ["t"])));
    expect(r).toEqual({ format: "webaios-firefox-census", total: 80, parConstructeur: [{ nom: "Object", nombre: 2, taille: 64 }, { nom: "strings", nombre: 1, taille: 16 }, { nom: "scripts", nombre: 0, taille: 0 }] });
    expect(mem.state).toBe("attached");
    expect(mem.calls).toEqual([]);
  } finally {
    liveTarget = null;
  }
});

it("two instantaneMemoire on one tab at once both answer, and the front they attached is detached after", async () => {
  const mem = memoryFront("detached");
  liveTarget = { isDestroyed: () => false, getFront: async () => mem };
  try {
    const browser = browserAt("http://127.0.0.1:5300/");
    const { devtools } = setup({ ensure: async () => browser });
    const { token } = devtools.owner();
    await Promise.all([devtools.call(token, "instantaneMemoire", ["t"]), devtools.call(token, "instantaneMemoire", ["t"])]);
    expect(mem.state).toBe("detached");
  } finally {
    liveTarget = null;
  }
});

it("a profile cut while its StartProfiler is still in flight stops the profiler once the start has landed", async () => {
  const cut = new AbortController();
  let active = false;
  (globalThis as any).Services = {
    profiler: {
      IsActive: () => active,
      StartProfiler: () => {
        cut.abort(); // cut right after the call, before the start lands
        return new Promise<void>((r) => setTimeout(() => ((active = true), r()), 30));
      },
      StopProfiler: async () => void (active = false),
      getProfileDataAsync: async () => ({ meta: {}, threads: [], processes: [] }),
    },
  };
  const browser = { ...browserAt("http://127.0.0.1:5300/"), browserId: 1, browsingContext: { currentWindowGlobal: { osPid: 42, innerWindowId: 1 } } };
  const { devtools } = setup({ ensure: async () => browser });
  await expect(devtools.call(devtools.owner().token, "profiler", ["t", { dureeMs: 1000 }], cut.signal)).rejects.toBeDefined();
  await new Promise((r) => setTimeout(r, 60));
  expect(active).toBe(false);
});
