import { afterEach, expect, test } from "vitest";
import { CODE_MODEL } from "../../ui/builder/add";
import { unsavedCodes, CodeFile, keepCodesOf, forgetCodes, type DepotCode } from "../../ui/builder/codes.svelte";

function fake(files: Record<string, string> = {}) {
  const state = { files: { ...files }, denial: false };
  const writes: { name: string; text: string }[] = [];
  const repo: DepotCode = {
    readCode: async (_id, name) => (name in state.files ? { text: state.files[name]! } : { absent: true }),
    saveCode: async (_id, name, text) => {
      if (state.denial) return { ok: false, error: "Écriture impossible" };
      writes.push({ name: name, text: text });
      state.files[name] = text;
      return { ok: true };
    },
  };
  return { depot: repo, state: state, writes: writes };
}

afterEach(() => forgetCodes());

test("a keystroke creates an unsaved draft, nothing is written; Enregistrer writes it and clears it", async () => {
  const f = fake({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.read();
  expect(c.text).toBe("v1");
  expect(c.unsaved).toBe(false);
  c.enter("v2");
  expect(c.text).toBe("v2");
  expect(c.unsaved).toBe(true);
  expect(unsavedCodes("w")).toEqual(["a.mjs"]);
  expect(f.writes).toEqual([]);
  await c.save();
  expect(f.writes).toEqual([{ name: "a.mjs", text: "v2" }]);
  expect(c.unsaved).toBe(false);
  expect(unsavedCodes("w")).toEqual([]);
});

test("going back to the disk's text clears the draft; Enregistrer without a draft writes nothing", async () => {
  const f = fake({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.read();
  c.enter("v2");
  c.enter("v1");
  expect(c.unsaved).toBe(false);
  await c.save();
  expect(f.writes).toEqual([]);
});

test("the draft outlives the editor (block or tab change): a new editor picks it up", async () => {
  const f = fake({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.read();
  c.enter("mien");
  const d = new CodeFile("w", "a.mjs", f.depot);
  await d.read();
  expect(d.text).toBe("mien");
  expect(d.unsaved).toBe(true);
  expect(unsavedCodes("autre")).toEqual([]);
});

test("missing file: the template is shown, unsaved, without a draft until something is typed", async () => {
  const f = fake();
  const c = new CodeFile("w", "neuf.mjs", f.depot);
  await c.read();
  expect(c.text).toBe(CODE_MODEL);
  expect(c.unsaved).toBe(true);
  expect(unsavedCodes("w")).toEqual([]);
  await c.save();
  expect(f.writes).toEqual([{ name: "neuf.mjs", text: CODE_MODEL }]);
  expect(c.unsaved).toBe(false);
});

test("the file changes on disk during a draft: banner; Recharger takes the disk", async () => {
  const f = fake({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.read();
  c.enter("mien");
  await c.read();
  expect(c.changedOnDisk).toBe(false);
  f.state.files["a.mjs"] = "agent";
  await c.read();
  expect(c.changedOnDisk).toBe(true);
  expect(c.text).toBe("mien");
  c.reload();
  expect(c.text).toBe("agent");
  expect(c.changedOnDisk).toBe(false);
  expect(c.unsaved).toBe(false);
});

test("Garder le mien: the banner goes, the draft stays and is saved over it", async () => {
  const f = fake({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.read();
  c.enter("mien");
  f.state.files["a.mjs"] = "agent";
  await c.read();
  c.keepMine();
  expect(c.changedOnDisk).toBe(false);
  await c.read();
  expect(c.changedOnDisk).toBe(false);
  expect(c.text).toBe("mien");
  await c.save();
  expect(f.state.files["a.mjs"]).toBe("mien");
});

test("without a draft, a change on disk is shown as is; a disk equal to the draft clears it", async () => {
  const f = fake({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.read();
  f.state.files["a.mjs"] = "agent";
  await c.read();
  expect(c.text).toBe("agent");
  c.enter("pareil");
  f.state.files["a.mjs"] = "pareil";
  await c.read();
  expect(c.unsaved).toBe(false);
  expect(c.changedOnDisk).toBe(false);
});

test("write refused: the draft stays with the error", async () => {
  const f = fake({ "a.mjs": "v1" });
  f.state.denial = true;
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.read();
  c.enter("v2");
  await c.save();
  expect(c.error).toBe("Écriture impossible");
  expect(c.unsaved).toBe(true);
});

test("a keystroke during the save stays a draft", async () => {
  const f = fake({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.read();
  c.enter("v2");
  const p = c.save();
  c.enter("v3");
  await p;
  expect(f.state.files["a.mjs"]).toBe("v2");
  expect(c.text).toBe("v3");
  expect(c.unsaved).toBe(true);
});

test("forgetCodes(widget) only clears that widget's drafts", async () => {
  const f = fake({ "a.mjs": "v1" });
  const a = new CodeFile("w", "a.mjs", f.depot);
  const b = new CodeFile("x", "a.mjs", f.depot);
  await a.read();
  await b.read();
  a.enter("1");
  b.enter("2");
  forgetCodes("w");
  expect(unsavedCodes("w")).toEqual([]);
  expect(unsavedCodes("x")).toEqual(["a.mjs"]);
  expect(unsavedCodes()).toEqual(["x/a.mjs"]);
});

test("keepCodesOf drops the drafts of widgets whose builder is no longer open", async () => {
  const f = fake({ "a.mjs": "v1" });
  const a = new CodeFile("w", "a.mjs", f.depot);
  const b = new CodeFile("x", "a.mjs", f.depot);
  await a.read();
  await b.read();
  a.enter("1");
  b.enter("2");
  keepCodesOf(["x", "autre"]);
  expect(unsavedCodes()).toEqual(["x/a.mjs"]);
});

test("a saved code signals it (the workflow blocked on that file restarts); a refusal signals nothing", async () => {
  const f = fake();
  const reported: string[] = [];
  const c = new CodeFile("w", "b.mjs", f.depot, (name) => reported.push(name));
  await c.read();
  f.state.denial = true;
  await c.save();
  expect(reported).toEqual([]);
  f.state.denial = false;
  await c.save();
  expect(reported).toEqual(["b.mjs"]);
});
