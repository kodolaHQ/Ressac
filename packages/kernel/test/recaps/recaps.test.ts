import { afterEach, describe, expect, test, vi } from "vitest";
import { readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRecaps, ID_RECAP, RECAP_UNKNOWN } from "../../src/recaps/recaps.js";
import { SeenUrls } from "../../src/mcp/seen.js";
import { tempFolder } from "../helpers/temp.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { fakeRunner } from "../helpers/fake-runner.js";

// Runs once right after the next readFile, to put a remove between page()'s read and its stamp.
const hooks = vi.hoisted(() => ({ afterRead: null as null | (() => Promise<void>) }));
vi.mock("node:fs/promises", async (original) => {
  const m = await original<typeof import("node:fs/promises")>();
  return {
    ...m,
    readFile: (async (...a: Parameters<typeof m.readFile>) => {
      const r = await m.readFile(...a);
      const h = hooks.afterRead;
      hooks.afterRead = null;
      await h?.();
      return r;
    }) as typeof m.readFile,
  };
});

const DAY = 24 * 3600 * 1000;
const results = {
  items: [
    { name: "A", url: "https://exemple.fr/a", photo: "https://img.fr/a.jpg" },
    { name: "B", url: "https://jamais.vu/b", photo: "http://img.fr/b.jpg" },
    { name: "C", url: "http://127.0.0.1/c" },
  ],
};
const plan = { blocks: [{ component: "cards", props: { items: "items", title: "name", link: "url", image: "photo" } }] };

async function setup() {
  const folder = await tempFolder();
  let clock = new Date("2026-11-13T10:00:00Z");
  const recaps = createRecaps({ folder, now: () => clock });
  const seen = new SeenUrls();
  seen.add(["https://exemple.fr/a", "https://img.fr/a.jpg", "http://img.fr/b.jpg", "http://127.0.0.1/c"]);
  return { folder, recaps, seen, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

test("publish without id creates the file; links never seen and local addresses are not allowed", async () => {
  const { folder, recaps, seen } = await setup();
  const r = await recaps.publish({ title: "Vélos", results, plan, seen });
  if (!r.ok) throw new Error(r.errors.join());
  expect(r.created).toBe(true);
  expect(r.id).toMatch(ID_RECAP);
  const file = JSON.parse(await readFile(join(folder, `${r.id}.json`), "utf8"));
  expect(file).toMatchObject({ version: 1, id: r.id, title: "Vélos", results, updated: "2026-11-13T10:00:00.000Z" });
  expect(file).not.toHaveProperty("shown");
  expect(await recaps.linkAllowed(r.id, "https://exemple.fr/a")).toBe(true);
  expect(await recaps.linkAllowed(r.id, "https://jamais.vu/b")).toBe(false);
  expect(await recaps.linkAllowed(r.id, "http://127.0.0.1/c")).toBe(false);
  expect(await recaps.imageAllowed(r.id, "https://img.fr/a.jpg")).toBe(true);
  expect(await recaps.imageAllowed(r.id, "http://img.fr/b.jpg")).toBe(false);
  const p = await recaps.page(r.id);
  if (!p || "gone" in p) throw new Error("no page");
  const cards = (p.page.blocks[0] as { props: unknown }).props as { items: { title: string; link: { url: string | null } | null }[] };
  expect(cards.items.map((c) => c.link?.url)).toEqual(["https://exemple.fr/a", null, null]);
});

test("republish with the id keeps a link seen before, even with an empty seen list", async () => {
  const { recaps, seen } = await setup();
  const r = await recaps.publish({ title: "Vélos", results, plan, seen });
  if (!r.ok) throw new Error();
  const again = await recaps.publish({ id: r.id, title: "Vélos 2", results, plan, seen: new SeenUrls() });
  expect(again).toEqual({ ok: true, id: r.id, created: false, discarded: [] });
  expect(await recaps.linkAllowed(r.id, "https://exemple.fr/a")).toBe(true);
  expect((await recaps.read(r.id))?.title).toBe("Vélos 2");
});

test("page() stamps the mtime; stale gives the id after 7 days of use", async () => {
  const { folder, recaps, seen, advance } = await setup();
  const r = await recaps.publish({ title: "Vélos", results, plan, seen });
  if (!r.ok) throw new Error();
  advance(3 * DAY);
  await recaps.page(r.id);
  expect((await stat(join(folder, `${r.id}.json`))).mtime.toISOString()).toBe("2026-11-16T10:00:00.000Z");
  for (let day = 1; day <= 6; day++) {
    advance(DAY);
    expect(await recaps.stale(7)).toEqual([]);
  }
  advance(DAY);
  expect(await recaps.stale(7)).toEqual([r.id]);
});

test("days the browser did not run do not count", async () => {
  const { recaps, seen, advance } = await setup();
  const r = await recaps.publish({ title: "Vélos", results, plan, seen });
  if (!r.ok) throw new Error();
  advance(DAY);
  expect(await recaps.stale(7)).toEqual([]);
  advance(30 * DAY);
  expect(await recaps.stale(7)).toEqual([]);
  // Several sweeps on one day count once.
  for (let i = 0; i < 5; i++) {
    advance(60_000);
    expect(await recaps.stale(7)).toEqual([]);
  }
  for (let day = 1; day <= 5; day++) {
    advance(DAY);
    expect(await recaps.stale(7)).toEqual(day < 5 ? [] : [r.id]);
  }
});

test("remove erases; page then says gone; republishing that id fails", async () => {
  const { recaps, seen } = await setup();
  const r = await recaps.publish({ title: "Vélos", results, plan, seen });
  if (!r.ok) throw new Error();
  await recaps.remove(r.id);
  expect(await recaps.page(r.id)).toEqual({ gone: true });
  expect(await recaps.publish({ id: r.id, title: "Vélos", results, plan, seen })).toEqual({ ok: false, errors: [RECAP_UNKNOWN] });
  expect(await recaps.page("pas-un-id")).toBeNull();
});

test("a refused plan gives validatePlan's errors and writes nothing", async () => {
  const { folder, recaps, seen } = await setup();
  const r = await recaps.publish({ title: "Vélos", results, plan: { blocks: [] }, seen });
  expect(r.ok).toBe(false);
  expect(await readdir(folder)).toEqual([]);
});

test("a page() racing a remove does not bring the recap back", async () => {
  const { folder, recaps, seen } = await setup();
  const r = await recaps.publish({ title: "Vélos", results, plan, seen });
  if (!r.ok) throw new Error();
  hooks.afterRead = () => recaps.remove(r.id);
  expect(await recaps.page(r.id)).toEqual({ gone: true });
  expect(await readdir(folder)).toEqual([]);
});

test("a republish landing between page()'s read and its stamp keeps the new content", async () => {
  const { recaps, seen } = await setup();
  const r = await recaps.publish({ title: "Vélos", results, plan, seen });
  if (!r.ok) throw new Error();
  hooks.afterRead = async () => {
    await recaps.publish({ id: r.id, title: "Vélos 2", results, plan, seen });
  };
  await recaps.page(r.id);
  expect((await recaps.read(r.id))?.title).toBe("Vélos 2");
});

test("page() after remove says gone and does not recreate the file", async () => {
  const { folder, recaps, seen } = await setup();
  const r = await recaps.publish({ title: "Vélos", results, plan, seen });
  if (!r.ok) throw new Error();
  await recaps.remove(r.id);
  expect(await recaps.page(r.id)).toEqual({ gone: true });
  expect(await readdir(folder)).toEqual([]);
});

test("stale follows the mtime: one shown before 7 days of use is swept, a fresh one is not", async () => {
  const { folder, recaps, seen, advance } = await setup();
  for (let day = 0; day < 7; day++) {
    await recaps.stale(7);
    advance(DAY);
  }
  const a = await recaps.publish({ title: "A", results, plan, seen });
  const b = await recaps.publish({ title: "B", results, plan, seen });
  if (!a.ok || !b.ok) throw new Error();
  const past = new Date("2026-11-12T10:00:00Z");
  await utimes(join(folder, `${a.id}.json`), past, past);
  expect(await recaps.stale(7)).toEqual([a.id]);
});

test("an old file with a shown field still reads", async () => {
  const { folder, recaps, seen } = await setup();
  const r = await recaps.publish({ title: "Vélos", results, plan, seen });
  if (!r.ok) throw new Error();
  const file = join(folder, `${r.id}.json`);
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), shown: "2026-11-13T10:00:00.000Z" }));
  expect((await recaps.read(r.id))?.title).toBe("Vélos");
});

test("the title keeps 120 characters", async () => {
  const { recaps, seen } = await setup();
  const r = await recaps.publish({ title: "x".repeat(130), results, plan, seen });
  if (!r.ok) throw new Error();
  expect((await recaps.read(r.id))?.title).toHaveLength(120);
});

describe("sweep of forgotten recaps", () => {
  let kernel: Kernel | undefined;
  afterEach(async () => {
    await kernel?.stop();
    kernel = undefined;
  });

  /** Two recaps published in 2020, then a kernel that sweeps at 60 s; `before` can show some on screen first. */
  async function start(bridge: FakeBridge, before: (ids: string[]) => void = () => {}) {
    const root = await tempFolder();
    const recapsFolder = `${root}-recaps`;
    const old = createRecaps({ folder: recapsFolder, now: () => new Date("2020-01-01T00:00:00Z") });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await old.publish({ title: `R${i}`, results, plan, seen: new SeenUrls() });
      if (!r.ok) throw new Error("publish");
      ids.push(r.id);
    }
    before(ids);
    const { run } = fakeRunner([[/ info$/, { code: 1, stderr: "Cannot connect to the Docker daemon" }]]);
    kernel = await createKernel({ widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, recapsFolder, recapsDayMs: 20, bridge, root, run });
    return { recapsFolder, ids };
  }
  const files = async (folder: string) => (await readdir(folder)).filter((f) => f.endsWith(".json") && f !== "used-days.json").sort();

  test("a stale recap off screen is closed and removed; a visible one is kept", async () => {
    const bridge = new FakeBridge([], { active: null, allow: false });
    const { recapsFolder, ids } = await start(bridge, (ids) => bridge.recapsOpened.push(ids[1]!));
    await vi.waitFor(async () => expect(await files(recapsFolder)).toEqual([`${ids[1]}.json`]));
    expect(bridge.recapsOpened).toEqual([ids[1]]);
  });

  test("a bridge that throws never crashes the kernel", async () => {
    const bridge = new FakeBridge([], { active: null, allow: false });
    bridge.recaps.visible = async () => {
      throw new Error("tab gone");
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { recapsFolder } = await start(bridge);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("recap sweep"), expect.anything()));
    expect(await files(recapsFolder)).toHaveLength(2);
    error.mockRestore();
  });
});
