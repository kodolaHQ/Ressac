import { expect, test, vi } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRecaps, ID_RECAP, RECAP_UNKNOWN } from "../../src/recaps/recaps.js";
import { SeenUrls } from "../../src/mcp/seen.js";
import { tempFolder } from "../helpers/temp.js";

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
  expect(file).toMatchObject({ version: 1, id: r.id, title: "Vélos", results, updated: "2026-11-13T10:00:00.000Z", shown: "2026-11-13T10:00:00.000Z" });
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

test("page() stamps shown; stale gives the id once its age passes", async () => {
  const { recaps, seen, advance } = await setup();
  const r = await recaps.publish({ title: "Vélos", results, plan, seen });
  if (!r.ok) throw new Error();
  advance(3 * DAY);
  await recaps.page(r.id);
  expect((await recaps.read(r.id))?.shown).toBe("2026-11-16T10:00:00.000Z");
  advance(5 * DAY);
  expect(await recaps.stale(7 * DAY)).toEqual([]);
  advance(3 * DAY);
  expect(await recaps.stale(7 * DAY)).toEqual([r.id]);
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

test("the title keeps 120 characters", async () => {
  const { recaps, seen } = await setup();
  const r = await recaps.publish({ title: "x".repeat(130), results, plan, seen });
  if (!r.ok) throw new Error();
  expect((await recaps.read(r.id))?.title).toHaveLength(120);
});
