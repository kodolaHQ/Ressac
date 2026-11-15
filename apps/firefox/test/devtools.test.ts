import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../core/state/initial-state";
import { createDevTools, geckoToCpuProfile, REVOKED_TEXT } from "../chrome/store/devtools";
import { createStore } from "../chrome/store/store";
import type { WindowRegistry } from "../chrome/store/windows";

/** Fake DevTools clients (CommandsFactory.forTab): their top-level target is destroyed, as right after a navigation,
 * unless a test sets `liveTarget`. */
const clients: { destroyed: boolean }[] = [];
let liveTarget: unknown = null;
/** The fake clients' evaluation (scriptCommand.execute). */
let execute: () => Promise<unknown> = async () => ({ result: 1 });
(globalThis as any).ChromeUtils = {
  importESModule: () => ({
    require: () => ({
      CommandsFactory: {
        forTab: async () => {
          const c = {
            destroyed: false,
            targetCommand: { TYPES: { FRAME: "frame" }, startListening: async () => {}, watchTargets: async () => {}, targetFront: liveTarget ?? { isDestroyed: () => true } },
            resourceCommand: { TYPES: { CONSOLE_MESSAGE: "c", ERROR_MESSAGE: "e", NETWORK_EVENT: "n", DOCUMENT_EVENT: "d" }, watchResources: async () => {} },
            scriptCommand: { execute: () => execute() },
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
  const store = createStore(initialState());
  store.dispatch({ type: "openTab", windowId: store.state.windows[0]!.id, url: "http://127.0.0.1:5300/", activate: true }, () => "t");
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
  await expect(devtools.call(token, "attach", ["t"])).rejects.toMatchObject({ name: "PrivateTab", id: "t" });
  await expect(devtools.call(token, "console", ["t", "http://127.0.0.1:5300"])).rejects.toMatchObject({ name: "PrivateTab" });
  expect(loaded).toEqual([]);
  expect(devtools.attached()).toEqual([]);
});

it("an unknown tab: TabNotFound", async () => {
  const { devtools } = setup();
  await expect(devtools.call(devtools.owner().token, "console", ["gone", "http://127.0.0.1:5300"])).rejects.toMatchObject({ name: "TabNotFound", id: "gone" });
});

it("a new owner revokes the previous one; a released owner is refused; a method not provided is refused", async () => {
  const { devtools } = setup();
  const first = devtools.owner().token;
  const second = devtools.owner().token;
  await expect(devtools.call(first, "console", ["t", "http://127.0.0.1:5300"])).rejects.toThrow(REVOKED_TEXT);
  await expect(devtools.call(second, "attaches" as never, [])).rejects.toThrow("Pas encore disponible");
  await expect(devtools.call(second, "constructor" as never, [])).rejects.toThrow("Pas encore disponible");
  devtools.release(first); // not the current one: nothing happens
  await expect(devtools.call(second, "console", ["t", "http://127.0.0.1:5300"])).rejects.toThrow("no browser");
  devtools.release();
  await expect(devtools.call(second, "console", ["t", "http://127.0.0.1:5300"])).rejects.toThrow(REVOKED_TEXT);
});

it("an old owner's call still loading its tab when a new owner comes attaches nothing", async () => {
  let give: (b: unknown) => void = () => {};
  const { devtools } = setup({ ensure: () => new Promise((r) => (give = r)) });
  const before = clients.length;
  const old = devtools.call(devtools.owner().token, "console", ["t", "http://127.0.0.1:5300"]);
  devtools.owner();
  give(browserAt("http://127.0.0.1:5300/"));
  await expect(old).rejects.toThrow(REVOKED_TEXT);
  expect(devtools.attached()).toEqual([]);
  expect(clients.slice(before).every((c) => c.destroyed)).toBe(true);
});

it("the tab on another origin (a navigation not heard): the session is dropped and a new one attached", async () => {
  const browser = browserAt("http://127.0.0.1:5300/");
  const { devtools } = setup({ ensure: async () => browser });
  const { token } = devtools.owner();
  const before = clients.length;
  await devtools.call(token, "console", ["t", "http://127.0.0.1:5300"]);
  browser.currentURI.spec = "http://localhost:5300/";
  await devtools.call(token, "console", ["t", "http://localhost:5300"]);
  expect(clients.length - before).toBe(2);
  await new Promise((r) => setTimeout(r, 0));
  expect(clients[before]!.destroyed).toBe(true);
  expect(clients[before + 1]!.destroyed).toBe(false);
});

it("a call for an origin the tab no longer shows: SiteChanged, no DevTools client attached to the new page", async () => {
  const { devtools } = setup({ ensure: async () => browserAt("http://localhost:5300/") });
  const before = clients.length;
  await expect(devtools.call(devtools.owner().token, "run", ["t", "http://127.0.0.1:5300", "1"])).rejects.toMatchObject({ name: "SiteChanged", id: "t" });
  expect(clients.length).toBe(before);
});

it("run retried after a navigation to another origin does not run the code there", async () => {
  const browser = browserAt("http://127.0.0.1:5300/");
  liveTarget = { isDestroyed: () => false };
  let runs = 0;
  execute = async () => {
    runs++;
    browser.currentURI.spec = "http://localhost:5300/";
    throw new Error("Target already destroyed");
  };
  const { devtools } = setup({ ensure: async () => browser });
  await expect(devtools.call(devtools.owner().token, "run", ["t", "http://127.0.0.1:5300", "1"])).rejects.toMatchObject({ name: "SiteChanged" });
  expect(runs).toBe(1);
});

it("a call waiting for the page's next target ends as soon as the session is dropped", async () => {
  const { devtools } = setup({ ensure: async () => browserAt("http://127.0.0.1:5300/") });
  const { token } = devtools.owner();
  const t0 = Date.now();
  const run = devtools.call(token, "run", ["t", "http://127.0.0.1:5300", "1"]);
  await new Promise((r) => setTimeout(r, 50));
  await devtools.call(token, "detach", ["t"]);
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

it("memorySnapshot leaves a memory front attached by someone else (the person's Memory panel) attached", async () => {
  const mem = memoryFront("attached");
  liveTarget = { isDestroyed: () => false, getFront: async () => mem };
  try {
    const { devtools } = setup({ ensure: async () => browserAt("http://127.0.0.1:5300/") });
    const r = JSON.parse(String(await devtools.call(devtools.owner().token, "memorySnapshot", ["t", "http://127.0.0.1:5300"])));
    expect(r).toEqual({ format: "ressac-firefox-census", total: 80, byConstructor: [{ name: "Object", count: 2, size: 64 }, { name: "strings", count: 1, size: 16 }, { name: "scripts", count: 0, size: 0 }] });
    expect(mem.state).toBe("attached");
    expect(mem.calls).toEqual([]);
  } finally {
    liveTarget = null;
  }
});

it("two memorySnapshot on one tab at once both answer, and the front they attached is detached after", async () => {
  const mem = memoryFront("detached");
  liveTarget = { isDestroyed: () => false, getFront: async () => mem };
  try {
    const browser = browserAt("http://127.0.0.1:5300/");
    const { devtools } = setup({ ensure: async () => browser });
    const { token } = devtools.owner();
    await Promise.all([devtools.call(token, "memorySnapshot", ["t", "http://127.0.0.1:5300"]), devtools.call(token, "memorySnapshot", ["t", "http://127.0.0.1:5300"])]);
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
  await expect(devtools.call(devtools.owner().token, "profile", ["t", "http://127.0.0.1:5300", { durationMs: 1000 }], cut.signal)).rejects.toBeDefined();
  await new Promise((r) => setTimeout(r, 60));
  expect(active).toBe(false);
});

/** A GeckoMain thread: one sample per [function, innerWindowID] pair, 1 ms apart; `reflows` gives each Reflow marker's window. */
function geckoThread(calls: [string, number][], reflows: (number | undefined)[] = []) {
  const stringTable: string[] = [];
  const str = (x: string) => (stringTable.includes(x) ? stringTable.indexOf(x) : stringTable.push(x) - 1);
  return {
    name: "GeckoMain",
    pid: 42,
    samples: { schema: { stack: 0, time: 1 }, data: calls.map((_, i) => [i, i]) },
    stackTable: { schema: { prefix: 0, frame: 1 }, data: calls.map((_, i) => [null, i]) },
    frameTable: { schema: { location: 0, innerWindowID: 2, category: 6 }, data: calls.map(([f, w]) => [str(`${f} (http://127.0.0.1:5300/:3:1)`), null, w, null, null, null, 0]) },
    stringTable,
    markers: { schema: { name: 0, phase: 3, data: 5 }, data: reflows.map((w) => [str("Reflow (sync)"), 0, 0, 2, 0, w === undefined ? null : { innerWindowID: w }]) },
  };
}

it("geckoToCpuProfile keeps only the frames of the tab's own windows: another tab of the process is (program), out of the script time", () => {
  const r = geckoToCpuProfile(geckoThread([["mine", 1], ["theirs", 2], ["mine", 3], ["theirs", 2]]), [{ name: "JavaScript" }], new Set([1, 3]));
  const names = r.profile.nodes.map((n) => n.callFrame.functionName);
  expect(names).toContain("mine");
  expect(names).not.toContain("theirs");
  expect(names).toContain("(program)");
  expect(r.profile.samples.length).toBe(4);
  // Samples at 0, 1, 2, 3 ms, each lasting until the next: the two of "mine" count as script, not the two of "theirs".
  expect(r.scriptMs).toBe(2);
});

afterEach(() => {
  vi.useRealTimers();
  liveTarget = null;
  execute = async () => ({ result: 1 });
});

/** Services.profiler giving one empty GeckoMain thread of process 42, `pages` of tab 1. */
function fakeProfiler(reflows: (number | undefined)[] = []) {
  (globalThis as any).Services = {
    profiler: {
      IsActive: () => false,
      StartProfiler: async () => {},
      StopProfiler: async () => {},
      getProfileDataAsync: async () => ({
        meta: { categories: [] },
        threads: [geckoThread([], reflows)],
        pages: [{ tabID: 1, innerWindowID: 7 }, { tabID: 2, innerWindowID: 8 }],
        processes: [],
      }),
    },
  };
  return { ...browserAt("http://127.0.0.1:5300/"), browserId: 1, browsingContext: { currentWindowGlobal: { osPid: 42, innerWindowId: 7 } } };
}

it("profiler counts the reflows of the tab's own windows only", async () => {
  const browser = fakeProfiler([7, 8, undefined, 7]);
  liveTarget = { isDestroyed: () => false, getFront: async () => ({ measure: async () => ({ jsObjectsSize: 1, jsStringsSize: 0, jsOtherSize: 0 }) }) };
  const { devtools } = setup({ ensure: async () => browser });
  const r = (await devtools.call(devtools.owner().token, "profile", ["t", "http://127.0.0.1:5300", { durationMs: 0 }])) as { metrics: Record<string, number> };
  expect(r.metrics.LayoutCount).toBe(3);
});

it("profiler on a page that never answers its Nodes count or memory measure: the call answers without those metrics", async () => {
  vi.useFakeTimers();
  const browser = fakeProfiler();
  liveTarget = { isDestroyed: () => false, getFront: async () => ({ measure: () => new Promise(() => {}) }) };
  execute = () => new Promise(() => {});
  const { devtools } = setup({ ensure: async () => browser });
  let r: { metrics: Record<string, number> } | undefined;
  void devtools.call(devtools.owner().token, "profile", ["t", "http://127.0.0.1:5300", { durationMs: 0 }]).then((x) => (r = x as typeof r));
  await vi.advanceTimersByTimeAsync(25_000);
  expect(r?.metrics).toBeDefined();
  expect(r!.metrics).not.toHaveProperty("Nodes");
  expect(r!.metrics).not.toHaveProperty("JSHeapUsedSize");
});

it("memorySnapshot on a page whose census never comes fails with « La page ne répond pas. »", async () => {
  vi.useFakeTimers();
  const mem = { ...memoryFront("detached"), takeCensus: () => new Promise(() => {}) };
  liveTarget = { isDestroyed: () => false, getFront: async () => mem };
  const { devtools } = setup({ ensure: async () => browserAt("http://127.0.0.1:5300/") });
  const pending = devtools.call(devtools.owner().token, "memorySnapshot", ["t", "http://127.0.0.1:5300"]);
  const outcome = pending.then(() => "answered", (e: Error) => e.message);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await outcome).toBe("La page ne répond pas.");
});
