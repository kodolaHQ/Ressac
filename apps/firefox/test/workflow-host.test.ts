import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spacePaths } from "../../../packages/kernel/src/index";
import * as copy from "../host/workflow";
import { SchemaCodeWorkflow } from "../shared/api";
import { readCode, readEdit, saveCode, saveEdit, workflowOpen, WriteQueue } from "../host/workflow";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const workflow = {
  version: 1,
  blocks: [
    { id: "page", type: "source.page", position: { x: 0, y: 0 }, params: { url: "https://x.test/" } },
    { id: "sortie", type: "output", position: { x: 1, y: 0 }, params: {} },
  ],
  links: [{ from: "page", to: "sortie" }],
};

function mount() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-host-")));
  dirs.push(root);
  const paths = spacePaths(join(root, "workspace"));
  const folder = join(paths.widgets, "veille");
  mkdirSync(folder, { recursive: true });
  const decl = { name: "Veille", sizes: { min: { w: 1, h: 1 }, max: { w: 4, h: 4 }, default: { w: 2, h: 2 } }, sources: { account: [], public: ["x.test"] } };
  writeFileSync(join(folder, "widget.json"), JSON.stringify(decl));
  writeFileSync(join(folder, "workflow.json"), JSON.stringify(workflow));
  return { root: root, paths: paths, folder: folder, c: { paths: paths, widgetsFolder: join(root, "widgets") } };
}

describe("widget workflow edition", () => {
  it("reads the blocks, saves a valid draft, refuses an invalid one without touching the file", async () => {
    const m = mount();
    const e = await readEdit(m.c, "veille");
    expect(e).toMatchObject({ origin: "file", validation: { ok: true }, widget: { name: "Veille" } });
    expect((e?.raw as typeof workflow).blocks.map((b) => b.id)).toEqual(["page", "sortie"]);
    const moved = { ...workflow, blocks: [{ ...workflow.blocks[0]!, position: { x: 5, y: 5 } }, workflow.blocks[1]!] };
    expect(await saveEdit(m.c, "veille", moved)).toMatchObject({ ok: true, warnings: [] });
    const saved = readFileSync(join(m.folder, "workflow.json"), "utf8");
    expect(JSON.parse(saved).blocks[0].position).toEqual({ x: 5, y: 5 });
    const bad = await saveEdit(m.c, "veille", { version: 1, blocks: [], links: [] });
    expect(bad).toMatchObject({ ok: false, warnings: [] });
    expect(readFileSync(join(m.folder, "workflow.json"), "utf8")).toBe(saved);
  });

  it("refuse a symlinked widget folder and a hostile code name", async () => {
    const m = mount();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "workflow-outside-")));
    dirs.push(outside);
    writeFileSync(join(outside, "widget.json"), readFileSync(join(m.folder, "widget.json")));
    writeFileSync(join(outside, "tri.mjs"), "secret");
    renameSync(m.folder, join(m.paths.widgets, "old"));
    symlinkSync(outside, m.folder);
    expect(await readEdit(m.c, "veille")).toBeNull();
    expect(await saveEdit(m.c, "veille", workflow)).toMatchObject({ ok: false, error: "Widget introuvable", warnings: [] });
    expect(await readCode(m.paths, "veille", "tri.mjs")).toEqual({ error: "Widget introuvable" });
    expect(await saveCode(m.paths, "veille", "neuf.mjs", "pwned")).toEqual({ ok: false, error: "Widget introuvable" });
    expect(existsSync(join(outside, "workflow.json"))).toBe(false);
    expect(existsSync(join(outside, "neuf.mjs"))).toBe(false);

    const real = join(m.paths.widgets, "reel");
    mkdirSync(real);
    expect(await readCode(m.paths, "reel", "../x.mjs")).toEqual({ error: expect.any(String) });
    expect(await saveCode(m.paths, "reel", "../x.mjs", "pwned")).toMatchObject({ ok: false });
    expect(existsSync(join(m.paths.widgets, "x.mjs"))).toBe(false);
    expect(await saveCode(m.paths, "reel", "tri.mjs", "ok")).toEqual({ ok: true });
    expect(await readCode(m.paths, "reel", "tri.mjs")).toEqual({ text: "ok" });
  });
});

describe("WriteQueue", () => {
  it("runs one key in series, two keys in parallel", async () => {
    const q = new WriteQueue();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a1 = q.inSeries("a", async () => {
      log.push("a1-start");
      await gate;
      log.push("a1-end");
    });
    const a2 = q.inSeries("a", async () => void log.push("a2"));
    await q.inSeries("b", async () => void log.push("b"));
    expect(log).toEqual(["a1-start", "b"]);
    release();
    await Promise.all([a1, a2]);
    expect(log).toEqual(["a1-start", "b", "a1-end", "a2"]);
  });
});

describe("workflowOpen", () => {
  it("gives the open widget and the block selected on it only", () => {
    expect(workflowOpen("ressac://workflow/veille", { widget: "veille", block: "tri" })).toEqual({ widget: "veille", block: "tri" });
    expect(workflowOpen("ressac://workflow/veille", { widget: "autre", block: "tri" })).toEqual({ widget: "veille", block: null });
    expect(workflowOpen("https://x.test/", { widget: "veille", block: "tri" })).toBeNull();
    expect(workflowOpen(undefined, undefined)).toBeNull();
  });
});

describe("code schema", () => {
  it("limits the code by bytes, not characters", () => {
    // The byte limit is a refine, which the JSON schema cannot show: 256 KB of 2-byte characters is under the length limit.
    expect(SchemaCodeWorkflow.safeParse("é".repeat(128 * 1024 + 1)).success).toBe(false);
    expect(SchemaCodeWorkflow.safeParse("é".repeat(128 * 1024)).success).toBe(true);
  });
});

describe("fenetres.actives mirror", () => {
  it("sends only workflow URLs, on start and on each active-tab change", async () => {
    // bridge.ts loads invisible.ts, which asks ChromeUtils for a Firefox module at load time.
    (globalThis as { ChromeUtils?: unknown }).ChromeUtils ??= { importESModule: () => ({}) };
    const { initialState } = await import("../core/state/initial-state");
    const { createStore } = await import("../chrome/store/store");
    const { sendMirror, trackState } = await import("../chrome/agent/bridge");
    const store = createStore(initialState());
    const f = store.state.windows[0]!.id;
    const windows = { active: () => f } as unknown as Parameters<typeof trackState>[2];
    const sent: [string, unknown][] = [];
    const notify = (m: string, p: unknown) => void sent.push([m, p]);
    sendMirror(store, windows, notify);
    trackState(store, { notify, request: () => Promise.resolve() } as unknown as Parameters<typeof trackState>[1], windows);
    store.dispatch({ type: "openTab", windowId: f, url: "ressac://workflow/veille" }, () => "t1");
    store.dispatch({ type: "openTab", windowId: f, url: "https://x.test/" }, () => "t2");
    expect(sent.filter(([m]) => m === "windows.active").map(([, p]) => p)).toEqual([{ [f]: null }, { [f]: "ressac://workflow/veille" }, { [f]: null }]);
  });
});

/** A space with one action, `gitlab`, and its data folder outside the space. */
function mountAction(decl: object) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-action-")));
  dirs.push(root);
  const paths = spacePaths(join(root, "workspace"));
  const folder = join(paths.actions, "gitlab");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "action.json"), JSON.stringify(decl));
  return { paths: paths, folder: folder, c: { paths: paths, actionsFolder: join(root, "actions") } };
}

describe("action workflow edition", () => {
  const withInput = { name: "GitLab", input: { label: "Projet" }, sources: { public: ["gitlab.com"] }, layout: "Un tableau", maxDurationMinutes: 5 };
  const read = { id: "lire", type: "code", position: { x: 0, y: 0 }, params: { source: "lire.mjs" } };
  const toPage = { id: "sortie", type: "output", position: { x: 1, y: 0 }, params: { to: "page" } };
  const wf = { version: 1, blocks: [read, toPage], links: [{ from: "lire", to: "sortie" }] };

  it("a symlinked action folder gives null and writes nothing outside", async () => {
    const m = mountAction(withInput);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "workflow-outside-")));
    dirs.push(outside);
    writeFileSync(join(outside, "action.json"), readFileSync(join(m.folder, "action.json")));
    writeFileSync(join(outside, "workflow.json"), JSON.stringify(wf));
    writeFileSync(join(outside, "lire.mjs"), "secret");
    rmSync(m.folder, { recursive: true });
    symlinkSync(outside, m.folder);
    expect(await copy.actionFolder(m.paths, "gitlab")).toBeNull();
    expect(await copy.readActionEdit(m.c, "gitlab")).toBeNull();
    expect(await copy.readActionCode(m.paths, "gitlab", "lire.mjs")).toEqual({ error: expect.any(String) });
    expect(await copy.saveActionCode(m.paths, "gitlab", "neuf.mjs", "pwned")).toMatchObject({ ok: false });
    expect(await copy.saveActionEdit(m.c, "gitlab", wf)).toMatchObject({ ok: false });
    expect(existsSync(join(outside, "neuf.mjs"))).toBe(false);
  });
});
