import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODE_MAX_BYTES,
  writeMemory,
  paramsHash,
  storeCode,
  saveWorkflow,
  readDraft,
  readCodeFile,
  readMemory,
  withMemory,
  implicitWorkflow,
} from "../../src/index.js";

let root: string;
let files: string;
let data: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wf-edition-"));
  files = join(root, "widget");
  data = join(root, "donnees");
  await mkdir(files);
  await mkdir(data);
  await writeFile(join(files, "a.mjs"), "export default () => []");
});
afterEach(() => rm(root, { recursive: true, force: true }));

const wf = (key = "url", extra: Record<string, unknown> = {}) => ({
  version: 1,
  blocks: [
    { id: "a", type: "code", position: { x: 1, y: 2 }, params: { source: "a.mjs" } },
    { id: "n", type: "list.new", position: { x: 3, y: 4 }, params: { key: key } },
    { id: "s", type: "output", position: { x: 5, y: 6 }, params: { to: "widget" } },
  ],
  links: [{ from: "a", to: "n" }, { from: "n", to: "s" }],
  ...extra,
});
const rec = (raw: unknown) => saveWorkflow({ filesFolder: files, dataFolder: data, raw: raw });
const readJson = async () => JSON.parse(await readFile(join(files, "workflow.json"), "utf8"));

test("a valid workflow is written atomically and re-read identical", async () => {
  expect(await rec(wf())).toEqual({ ok: true, written: true, memoryErased: [] });
  expect(await readJson()).toEqual(wf());
  expect((await readFile(join(files, "workflow.json"), "utf8")).endsWith("}\n")).toBe(true);
  expect((await readdir(files)).sort()).toEqual(["a.mjs", "workflow.json"]); // no .tmp
  const lu = await readDraft(files);
  expect(lu).toMatchObject({ origin: "file", raw: wf(), validation: { ok: true } });
});

test("an invalid workflow writes nothing and returns the error with the block concerned", async () => {
  const withoutLink = { ...wf(), links: [{ from: "a", to: "s" }] }; // n without an input
  const r = await rec(withoutLink);
  expect(r).toMatchObject({ ok: false, block: "n" });
  expect(await readdir(files)).toEqual(["a.mjs"]);
});

test("a code block whose .mjs file is missing is refused (R3), with the block", async () => {
  const raw = wf();
  raw.blocks[0]!.params = { source: "absent.mjs" };
  expect(await rec(raw)).toEqual({ ok: false, error: "Non enregistré : fichier absent.mjs absent", block: "a" });
  expect(await readdir(files)).toEqual(["a.mjs"]);
});

test("saving the same workflow writes nothing (ecrit false, mtime unchanged)", async () => {
  await rec(wf());
  const past = new Date("2020-01-01T00:00:00Z");
  await utimes(join(files, "workflow.json"), past, past);
  // Same workflow, keys in another order.
  const sameOtherwise = { links: wf().links, blocks: wf().blocks.map((b) => ({ params: b.params, position: b.position, type: b.type, id: b.id })), version: 1 };
  expect(await rec(sameOtherwise)).toEqual({ ok: true, written: false, memoryErased: [] });
  expect((await stat(join(files, "workflow.json"))).mtime).toEqual(past);
});

test("the implicit one saved as is writes nothing; modified, it creates workflow.json and harvest.mjs stays", async () => {
  await writeFile(join(files, "harvest.mjs"), "export default () => []");
  const before = await readDraft(files);
  expect(before).toMatchObject({ origin: "implicit", raw: implicitWorkflow(), validation: { ok: true } });
  expect((await readdir(files)).sort()).toEqual(["a.mjs", "harvest.mjs"]); // lire writes nothing
  expect(await rec(before!.raw)).toEqual({ ok: true, written: false, memoryErased: [] });
  expect((await readdir(files)).sort()).toEqual(["a.mjs", "harvest.mjs"]);

  const moved = implicitWorkflow();
  moved.blocks[0]!.position = { x: 40, y: 50 };
  expect(await rec(moved)).toMatchObject({ ok: true, written: true });
  expect((await readdir(files)).sort()).toEqual(["a.mjs", "harvest.mjs", "workflow.json"]);
});

test("changing a block's parameters erases its memory, not the others'; changing its name or position does not erase it", async () => {
  await rec(wf());
  const m = {
    n: { type: "list.new", value: ["x"], hash: paramsHash({ key: "url" }) },
    a: { type: "code", value: 1 },
  };
  await writeMemory(data, m);

  const renamed = wf();
  renamed.blocks[1] = { ...renamed.blocks[1]!, name: "Autre nom", position: { x: 99, y: 99 } } as never;
  expect(await rec(renamed)).toEqual({ ok: true, written: true, memoryErased: [] });
  expect(await readMemory(data)).toEqual(m);

  expect(await rec(wf("titre"))).toEqual({ ok: true, written: true, memoryErased: ["n"] });
  expect(await readMemory(data)).toEqual({ a: m.a });
});

test("changing the parameters also erases a memory from before the hashes; an entry already at the new settings stays", async () => {
  await rec(wf());
  await writeMemory(data, { n: { type: "list.new", value: ["x"] }, a: { type: "code", value: 1 } });
  expect(await rec(wf("titre"))).toEqual({ ok: true, written: true, memoryErased: ["n"] });
  expect(await readMemory(data)).toEqual({ a: { type: "code", value: 1 } });

  // A run that already ran with the new settings (between the write and the erase) keeps its memory.
  const fresh = { n: { type: "list.new", value: ["y"], hash: paramsHash({ key: "id" }) } };
  await writeMemory(data, fresh);
  expect(await rec(wf("id"))).toEqual({ ok: true, written: true, memoryErased: [] });
  expect(await readMemory(data)).toEqual(fresh);
});

test("the erase waits for the memory lock (held by the runs) and goes before the workflow write", async () => {
  await rec(wf());
  await writeMemory(data, { n: { type: "list.new", value: ["x"], hash: paramsHash({ key: "url" }) } });
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  // A run started with the old settings writes its memory during the save.
  const execution = withMemory(data, async () => {
    await released;
    await writeMemory(data, {
      a: { type: "code", value: "fraiche" },
      n: { type: "list.new", value: ["x", "z"], hash: paramsHash({ key: "url" }) },
    });
  });
  const saving = rec(wf("titre"));
  await new Promise((r) => setTimeout(r, 30));
  // Nothing is written while the run holds the memory: neither the erase, nor the workflow.
  expect(JSON.parse(await readFile(join(files, "workflow.json"), "utf8")).blocks[1].params).toEqual({ key: "url" });
  release();
  await execution;
  expect(await saving).toEqual({ ok: true, written: true, memoryErased: ["n"] });
  // The run's fresh memory stays; the changed block's goes away.
  expect(await readMemory(data)).toEqual({ a: { type: "code", value: "fraiche" } });
});

test("nothing to erase: memory.json is not rewritten", async () => {
  await rec(wf());
  await writeMemory(data, { a: { type: "code", value: 1 } });
  const past = new Date("2020-01-01T00:00:00Z");
  await utimes(join(data, "memory.json"), past, past);
  expect(await rec(wf("titre"))).toEqual({ ok: true, written: true, memoryErased: [] });
  expect((await stat(join(data, "memory.json"))).mtime).toEqual(past);
});

test("changing the implicit one's parameters also erases the memory (compared to the implicit one)", async () => {
  await writeFile(join(files, "harvest.mjs"), "export default () => []");
  await writeMemory(data, { harvest: { type: "code", value: 1 } });
  const change = implicitWorkflow();
  change.blocks[0]!.params = { source: "a.mjs", call: "input" };
  expect(await rec(change)).toEqual({ ok: true, written: true, memoryErased: ["harvest"] });
});

test("workflow.json symbolic link to the outside: refused, the target is not touched", async () => {
  const outside = join(root, "dehors.json");
  await writeFile(outside, "intact");
  await symlink(outside, join(files, "workflow.json"));
  expect(await rec(wf())).toMatchObject({ ok: false });
  expect(await readFile(outside, "utf8")).toBe("intact");
  expect(await readDraft(files)).toMatchObject({ origin: "file", raw: null, validation: { ok: false } });
});

test("over 256 KB: refused; widget folder missing: Widget introuvable", async () => {
  const big = wf();
  big.blocks[1]!.params = { key: "x".repeat(300 * 1024) };
  expect((await rec(big)).ok).toBe(false);
  expect(await readdir(files)).toEqual(["a.mjs"]);
  const r = await saveWorkflow({ filesFolder: join(root, "nulle-part"), dataFolder: data, raw: wf() });
  expect(r).toEqual({ ok: false, error: "Widget introuvable" });
});

test("readDraft returns the JSON even invalid, null for a cut JSON, the implicit one for harvest.mjs alone", async () => {
  expect(await readDraft(files)).toBeNull();
  const invalid = { ...wf(), links: [] };
  await writeFile(join(files, "workflow.json"), JSON.stringify(invalid));
  const l = await readDraft(files);
  expect(l).toMatchObject({ origin: "file", raw: invalid, validation: { ok: false, block: "n" } });
  await writeFile(join(files, "workflow.json"), '{ "version": 1, "blo');
  expect(await readDraft(files)).toMatchObject({ origin: "file", raw: null, validation: { ok: false } });
  await writeFile(join(files, "workflow.json"), " ".repeat(300 * 1024));
  expect(await readDraft(files)).toMatchObject({ raw: null, validation: { ok: false } });
});

test("lireCode / enregistrerCode refuse ../x.mjs, x.js, an outgoing link, over 256 KB; a missing file returns absent", async () => {
  for (const name of ["../x.mjs", "x.js", "A.mjs", "sous/x.mjs"]) {
    expect(await readCodeFile(files, name)).toHaveProperty("error");
    expect(await storeCode(files, name, "x")).toMatchObject({ ok: false });
  }
  expect(await readCodeFile(files, "nouveau.mjs")).toEqual({ absent: true });
  expect(await readCodeFile(files, "a.mjs")).toEqual({ text: "export default () => []" });

  const outside = join(root, "dehors.mjs");
  await writeFile(outside, "intact");
  await symlink(outside, join(files, "lien.mjs"));
  const l = await readCodeFile(files, "lien.mjs");
  expect(l).toHaveProperty("error");
  expect(JSON.stringify(l)).not.toContain(root);
  expect(await storeCode(files, "lien.mjs", "écrasé")).toMatchObject({ ok: false });
  expect(await readFile(outside, "utf8")).toBe("intact");

  const big = "x".repeat(CODE_MAX_BYTES + 1);
  expect(await storeCode(files, "gros.mjs", big)).toMatchObject({ ok: false });
  await writeFile(join(files, "gros2.mjs"), big);
  expect(await readCodeFile(files, "gros2.mjs")).toHaveProperty("error");

  expect(await storeCode(files, "nouveau.mjs", "export default 1")).toEqual({ ok: true });
  expect(await readCodeFile(files, "nouveau.mjs")).toEqual({ text: "export default 1" });
  expect((await readdir(files)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

test("changing liste.nouveaux's garderJours does not erase its memory; changing cle erases it", async () => {
  const withKeep = (key: string, keepDays?: number) => {
    const w = wf(key);
    if (keepDays !== undefined) w.blocks[1]!.params = { key: key, keepDays: keepDays } as never;
    return w;
  };
  await rec(withKeep("url", 7));
  const m = { n: { type: "list.new", value: ["x"], hash: paramsHash({ key: "url", keepDays: 7 }) } };
  await writeMemory(data, m);
  expect(await rec(withKeep("url", 30))).toEqual({ ok: true, written: true, memoryErased: [] });
  expect(await rec(withKeep("url"))).toEqual({ ok: true, written: true, memoryErased: [] });
  expect(await readMemory(data)).toEqual(m);
  expect(await rec(withKeep("titre", 30))).toEqual({ ok: true, written: true, memoryErased: ["n"] });
  expect(await readMemory(data)).toEqual({});
});

test("the workflow in place is re-read with the widget's context: a long widget erases the memory and does not rewrite an identical file", async () => {
  const context = { web: false, maxDurationMinutes: 30, owner: "widget" as const, input: false };
  const long = (key: string) => {
    const w = wf(key);
    w.blocks.splice(1, 0, { id: "p", type: "source.page", position: { x: 0, y: 0 }, params: { url: "https://x.fr/{url}", perItem: true, budgetSeconds: 600 } } as never);
    w.links = [{ from: "a", to: "p" }, { from: "p", to: "n" }, { from: "n", to: "s" }];
    return w;
  };
  const longSave = (raw: unknown) => saveWorkflow({ filesFolder: files, dataFolder: data, raw: raw, context: context });
  // Without the context, this workflow is refused (600 s > 170 s).
  expect(await rec(long("url"))).toMatchObject({ ok: false, block: "p" });
  expect(await longSave(long("url"))).toEqual({ ok: true, written: true, memoryErased: [] });
  expect(await readDraft(files, context)).toMatchObject({ validation: { ok: true } });
  expect(await readDraft(files)).toMatchObject({ validation: { ok: false } });

  const past = new Date("2020-01-01T00:00:00Z");
  await utimes(join(files, "workflow.json"), past, past);
  expect(await longSave(long("url"))).toEqual({ ok: true, written: false, memoryErased: [] });
  expect((await stat(join(files, "workflow.json"))).mtime).toEqual(past);

  await writeMemory(data, { n: { type: "list.new", value: ["x"], hash: paramsHash({ key: "url" }) } });
  expect(await longSave(long("titre"))).toEqual({ ok: true, written: true, memoryErased: ["n"] });
});

test("saving web.search in a widget without web: refused, nothing written", async () => {
  const raw = wf();
  raw.blocks.splice(1, 0, { id: "w", type: "web.search", position: { x: 0, y: 0 }, params: { query: "{title}", perItem: true } } as never);
  raw.links = [{ from: "a", to: "w" }, { from: "w", to: "n" }, { from: "n", to: "s" }];
  const expected = { ok: false, error: 'Workflow invalide : web.search : le widget doit déclarer "web": true', block: "w" };
  expect(await rec(raw)).toEqual(expected);
  expect(await saveWorkflow({ filesFolder: files, dataFolder: data, raw: raw, context: { web: false, maxDurationMinutes: 30, owner: "widget" as const, input: false } })).toEqual(expected);
  expect(await readdir(files)).toEqual(["a.mjs"]);
  // With web, the same workflow is written.
  expect(await saveWorkflow({ filesFolder: files, dataFolder: data, raw: raw, context: { web: true, maxDurationMinutes: null, owner: "widget" as const, input: false } })).toMatchObject({ ok: true, written: true });
});
