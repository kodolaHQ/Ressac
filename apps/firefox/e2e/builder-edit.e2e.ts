import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, keyDown, keyUp, missingApi, pressKeys, typeText, waitUi } from "./ui";
import { nodes, openBuilder, readWorkflow, widgetDir, writeWidget } from "./workflows";

// The workflow builder on ressac://workflow/<widget>, opened from the home page's widget menu.

/** A workflow shipped by the agent, without positions: a page, its links taken by code, sorted by Kev, then their texts. */
const WATCH_WORKFLOW = {
  version: 1,
  blocks: [
    { id: "page", type: "source.page", params: { url: "{config.url}" } },
    { id: "liens", type: "code", name: "Liens de la page", params: { source: "liens.mjs" } },
    { id: "tri", type: "ai.sort", name: "Tri par Kev", params: { question: "Parle d'IA ?", text: "{text}", threshold: 0.5 } },
    { id: "textes", type: "code", params: { source: "textes.mjs" } },
    { id: "sortie", type: "output", params: { to: "widget" } },
  ],
  links: [
    { from: "page", to: "liens" },
    { from: "liens", to: "tri" },
    { from: "tri", to: "textes" },
    { from: "textes", to: "sortie" },
  ],
};

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** What the builder may have written in a widget's folder: names and modification times. */
const snapshot = async (dir: string) => (await Promise.all((await readdir(dir)).map(async (f) => `${f}:${(await stat(path.join(dir, f))).mtimeMs}`))).sort();

let dataDir: string;
let w: LaunchedRessac;
let m: Marionette;

// Local test servers: the site the widgets read, a fake Kev (an « IA » text scores 0.9) and a fake Ollama without Gemma.
type Server = { url: string; close(): Promise<void> };
async function listen(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  const server = createServer(handle);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((ok) => (server.closeAllConnections(), server.close(() => ok()))),
  };
}
let site: Server;
let kev: Server;
let ollama: Server;

/** The widgets built on WATCH_WORKFLOW, one per test that edits it (a builder keeps its draft per widget for the window). */
const WATCHES = ["add", "undo", "add-code", "run", "suppr", "field", "agent", "seuil", "gabarit", "code", "img", "close", "gone"];
/** The widget's data folder, outside the space (state, executions, memory). */
const dataOf = (id: string) => path.join(dataDir, "widgets", id);
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll<T>(read: () => Promise<T>, expected: T, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    let v: T | undefined;
    try {
      v = await read();
    } catch {}
    if (JSON.stringify(v) === JSON.stringify(expected)) return;
    if (Date.now() > deadline) return void expect(v).toEqual(expected);
    await sleep(100);
  }
}

const writeWatch = (id: string) =>
  writeWidget(dataDir, id, {
    name: "Veille",
    harvest: { minutes: 60 },
    declaration: { config: { url: `${site.url}/liens` } },
    workflow: WATCH_WORKFLOW,
    files: {
      "liens.mjs": "export default async (page) => page.links;",
      "textes.mjs": "export default async (liens) => ({ liens: liens.map((l) => l.text) });",
    },
  });

beforeAll(async () => {
  site = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<title>Liens</title><a href="https://exemple.invalid/ia">Nouveau modèle IA</a> <a href="https://exemple.invalid/cuisine">Recette de cuisine</a>');
  });
  kev = await listen((req, res) => {
    if (req.method === "GET") return void res.writeHead(200, { "Content-Type": "application/json" }).end('{"data":[]}');
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { state } = JSON.parse(body) as { state: string };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers: { q: { noul: /\bIA\b/.test(state) ? 0.9 : 0.1 } } }));
    });
  });
  ollama = await listen((_req, res) => void res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}'));

  dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-builder-"));
  await writeWidget(dataDir, "veille", {
    name: "Veille",
    harvest: { minutes: 60 },
    declaration: { config: { url: "https://exemple.invalid/liens" } },
    workflow: WATCH_WORKFLOW,
    files: {
      "liens.mjs": "export default async (page) => page.links;",
      "textes.mjs": "export default async (liens) => ({ liens: liens.map((l) => l.text) });",
    },
  });
  await writeWidget(dataDir, "sans", { name: "Sans récolte" });
  for (const id of WATCHES) await writeWatch(id);
  // Without a state: harvested at launch (scheduled).
  await rm(dataOf("run"), { recursive: true });
  // Only harvest.mjs: an implicit workflow (recolte → sortie).
  await writeWidget(dataDir, "compte", {
    name: "Compte",
    harvest: { minutes: 60 },
    declaration: { sources: { account: ["127.0.0.1"], public: [], web: false }, config: { url: `${site.url}/lire-cookie?compte` } },
    files: { "harvest.mjs": "export default async (ressac) => ({ vu: (await ressac.readPage(ressac.config.url, { account: true })).title });" },
  });
  await rm(dataOf("compte"), { recursive: true });
  await writeWidget(dataDir, "casse", { name: "Cassé", harvest: { minutes: 60 }, workflow: '{ "version": 1, "blocks": [ { "id": "page", "type": "source.pa' });
  await writeWidget(dataDir, "cycle", {
    name: "Cycle",
    harvest: { minutes: 60 },
    workflow: {
      version: 1,
      blocks: [
        { id: "a", type: "list.keep", params: { count: 1 } },
        { id: "b", type: "list.keep", params: { count: 1 } },
        { id: "sortie", type: "output", params: { to: "widget" } },
      ],
      links: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
        { from: "b", to: "sortie" },
      ],
    },
  });
  w = await launchRessac({ dataDir, height: 1400, env: { RESSAC_KEV_URL: kev.url, RESSAC_OLLAMA_URL: ollama.url, RESSAC_TEST_LOCAL_ADDRESSES: "1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
});
afterAll(async () => {
  await w?.close();
  await Promise.all([site, kev, ollama].map((s) => s?.close()));
  await rm(dataDir, { recursive: true, force: true });
});
afterEach(async () => {
  expect(await missingApi(m)).toEqual([]);
  // The sidebar's own confirm back (answerConfirm replaced it).
  await inUi(m, "if (ui.realConfirm) ui.confirm = ui.realConfirm; delete ui.realConfirm; delete ui.questions;");
  // Every builder is named « Veille »: one builder tab at a time, so « Workflow — Veille » is this test's.
  for (const o of Object.values((await state(m)).tabs)) if (o.url.startsWith("ressac://workflow/")) await dispatch(m, { type: "closeTab", id: o.id });
});

/** Back to the home page of the window. */
async function home(): Promise<void> {
  await dispatch(m, { type: "showBlankPage", windowId: (await state(m)).windows[0]!.id });
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"widget-veille\"]')");
}

/** Home, then the builder of `id`, once its canvas has stopped moving (fitted to its blocks). */
async function builder(id: string): Promise<void> {
  await home();
  await openBuilder(m, id);
  await waitUi(
    m,
    `const now = JSON.stringify([...doc.querySelectorAll(".svelte-flow__node")].map((n) => n.getBoundingClientRect()));
     await new Promise((r) => setTimeout(r, 150));
     return now === JSON.stringify([...doc.querySelectorAll(".svelte-flow__node")].map((n) => n.getBoundingClientRect()));`,
  );
}

const q = (testid: string) => `doc.querySelector('[data-testid="${testid}"]')`;
/** The text of a testid, or null if absent. */
const text = (testid: string) => inUi<string | null>(m, `return ${q(testid)}?.textContent.trim() ?? null`);
const count = (testid: string) => inUi<number>(m, `return doc.querySelectorAll('[data-testid="${testid}"]').length`);
const value = (testid: string) => inUi<string | null>(m, `return ${q(testid)}?.value ?? null`);
const waitText = (testid: string, t: string) => waitUi(m, `return ${q(testid)}?.textContent.trim() === arguments[0]`, [t]);
const waitContains = (testid: string, t: string) => waitUi(m, `return !!${q(testid)}?.textContent.includes(arguments[0])`, [t]);
const waitCount = (testid: string, n: number) => waitUi(m, `return doc.querySelectorAll('[data-testid="${testid}"]').length === arguments[0]`, [n]);
const waitValue = (testid: string, v: string) => waitUi(m, `return ${q(testid)}?.value === arguments[0]`, [v]);
const saved = () => waitText("save-status", "Enregistré");

/** Drags a link from block `from`'s output to block `to`'s input (trusted mouse events, in steps). */
async function link(from: string, to: string): Promise<void> {
  await inUi(
    m,
    `const centre = (s) => { const r = doc.querySelector(s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
     const ends = () => [...centre('[data-testid="node-' + arguments[0] + '"] .svelte-flow__handle.source'), ...centre('[data-testid="node-' + arguments[1] + '"] .svelte-flow__handle.target')];
     // A block just added is measured, then the view may move: wait until both ends stay put.
     let before = "";
     for (let i = 0; i < 50 && before !== JSON.stringify(ends()); i++) { before = JSON.stringify(ends()); await new Promise((r) => setTimeout(r, 100)); }
     const [ax, ay, bx, by] = ends();
     ui.synthesizeMouseEvent("mousemove", ax, ay, {});
     ui.synthesizeMouseEvent("mousedown", ax, ay, { button: 0, clickCount: 1 });
     for (let i = 1; i <= 12; i++) {
       ui.synthesizeMouseEvent("mousemove", ax + ((bx - ax) * i) / 12, ay + ((by - ay) * i) / 12, { button: 0, buttons: 1 });
       await new Promise((r) => requestAnimationFrame(r));
     }
     ui.synthesizeMouseEvent("mouseup", bx, by, { button: 0, clickCount: 1 });`,
    [from, to],
  );
}

/** Playwright's fill: clicks the field (focus), then replaces its value with one input event. */
async function fill(testid: string, v: string): Promise<void> {
  await click(m, `[data-testid="${testid}"]`);
  await inUi(m, `const el = ${q(testid)}; el.focus(); el.value = arguments[0]; el.dispatchEvent(new ui.InputEvent("input", { bubbles: true }));`, [v]);
}

/** Clicks the builder's heading: the keyboard leaves any field, for the canvas's ⌘Z. */
const clickHeading = () => click(m, '[data-testid="builder"] h1');

/** Replaces the sidebar's `confirm`: nothing shows, questions are noted, the answer is `answer`. */
const answerConfirm = (answer: boolean) =>
  inUi(m, "ui.questions ??= []; ui.realConfirm ??= ui.confirm; ui.confirm = (q) => (ui.questions.push(q ?? ''), arguments[0]);", [answer]);
const questions = () => inUi<string[]>(m, "return [...(ui.questions ?? [])]");
/** A beforeunload on the sidebar is held back (unsaved code). */
const closeHeld = () => inUi<boolean>(m, "const e = new ui.Event('beforeunload', { cancelable: true }); ui.dispatchEvent(e); return e.defaultPrevented;");

/** Presses a combo from a timer: a confirm() it opens blocks the script that pressed it until answered. */
const pressKeysLater = (combo: string) =>
  m.execute(
    `const keys = arguments[0].split("+");
     setTimeout(() => {
       const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
       tip.beginInputTransactionForTests(window);
       const ev = (key) => new KeyboardEvent("", { key, code: key === "Meta" ? "MetaLeft" : "Key" + key.toUpperCase() });
       for (const k of keys) tip.keydown(ev(k));
       for (const k of [...keys].reverse()) tip.keyup(ev(k));
     }, 0);`,
    [combo],
  );
/** The text of the prompt open in the window (WebDriver's user prompt), once it shows. Any other command would dismiss it. */
async function promptText(): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return (await m.command<{ value: string }>("WebDriver:GetAlertText")).value;
    } catch (e) {
      if (i > 100) throw e;
      await sleep(100);
    }
  }
}

/** The agent rewrites workflow.json (atomic write, like its tools). */
async function writeAsAgent(id: string, workflow: unknown): Promise<void> {
  const file = path.join(widgetDir(dataDir, id), "workflow.json");
  await writeFile(`${file}.agent`, JSON.stringify(workflow, null, 2));
  await rename(`${file}.agent`, file);
}
const withThreshold = (threshold: number) => ({
  ...WATCH_WORKFLOW,
  blocks: WATCH_WORKFLOW.blocks.map((b) => (b.id === "tri" ? { ...b, params: { ...b.params, threshold: threshold } } : b)),
});
const thresholdOf = async (id: string) => (await readWorkflow(dataDir, id)).blocks.find((b: { id: string }) => b.id === "tri").params.threshold;

describe("the workflow builder", () => {
  it("opening the builder of a shipped workflow without positions lays it out in columns and writes nothing", async () => {
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"widget-veille\"] iframe')");
    const before = await snapshot(widgetDir(dataDir, "veille"));
    await openBuilder(m, "veille");
    await waitUi(m, "return doc.querySelector('[data-testid=\"builder\"] h1')?.textContent === 'Veille'");
    const ids = ["page", "liens", "tri", "textes", "sortie"];
    expect((await waitUi<string[] | false>(m, "const n = [...doc.querySelectorAll('.svelte-flow__node')]; return n.length === 5 && n.map((x) => x.dataset.id)")) as string[]).toEqual(
      expect.arrayContaining(ids),
    );
    expect((await nodes(m)).sort()).toEqual([...ids].sort());
    const boxes = await inUi<Box[]>(
      m,
      "return arguments[0].map((id) => { const r = doc.querySelector('[data-testid=\"node-' + id + '\"]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })",
      [ids],
    );
    const links = await inUi<string>(m, "return doc.querySelector('[data-testid=\"node-liens\"]').textContent");
    expect(links).toContain("Liens de la page");
    expect(links).toContain("code");
    // One column per rank, left to right, no overlap.
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x + boxes[i - 1]!.width / 2);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i]!, boxes[j]!)).toBe(false);
    expect(await waitUi(m, "return doc.querySelector('[data-testid=\"save-status\"]')?.textContent.trim() === 'Enregistré'")).toBe(true);

    // Selecting and reorganising write nothing either.
    await click(m, '[data-testid="node-tri"]');
    await click(m, '[data-testid="rearrange"]');
    await new Promise((r) => setTimeout(r, 1000));
    expect(await snapshot(widgetDir(dataDir, "veille"))).toEqual(before);
  });

  it("a widget without a harvest has no « Voir / modifier le workflow » in its menu", async () => {
    await home();
    await click(m, '[data-testid="widget-sans"] button[aria-label="Options du widget"]');
    const items = await waitUi<string[] | false>(m, "const l = [...doc.querySelectorAll('[data-testid=\"widget-sans\"] [role=\"menuitem\"]')]; return l.length > 0 && l.map((b) => b.textContent.trim())");
    expect(items).toEqual(["Mettre à jour maintenant", "Retirer"]);
    // Closes the menu.
    await click(m, '[data-testid="widget-sans"] button[aria-label="Options du widget"]');
  });

  it("opening the same widget's entry twice keeps a single builder tab", async () => {
    await home();
    await openBuilder(m, "veille");
    await home();
    await openBuilder(m, "veille");
    const tabs = Object.values((await state(m)).tabs).filter((o) => o.url === "ressac://workflow/veille");
    expect(tabs.map((o) => o.title)).toEqual(["Workflow — Veille"]);
  });

  it("⌘J and ✦ on a builder tab show its Agent tab and open the agent panel, never closing it", async () => {
    await home();
    await openBuilder(m, "veille");
    const panelShown = () => m.execute<boolean>("return !document.getElementById('ressac-agent').hidden");
    const agentTab = () => inUi<string | null>(m, "return doc.querySelector('[data-testid=\"agent-tab\"]')?.getAttribute('aria-selected')");
    // Leaving the home page closed the panel it had opened.
    await waitFor(m, "return document.getElementById('ressac-agent').hidden", (v) => v === true);
    expect(await agentTab()).toBe("false");
    await pressKeys(m, "Meta+j");
    await waitFor(m, "return !document.getElementById('ressac-agent').hidden", (v) => v === true);
    expect(await waitUi(m, "return doc.querySelector('[data-testid=\"agent-tab\"]')?.getAttribute('aria-selected') === 'true'")).toBe(true);
    expect(await m.execute("return document.activeElement?.id")).toBe("ressac-agent");
    await pressKeys(m, "Meta+j");
    await click(m, '[data-testid="agent-button"]');
    await new Promise((r) => setTimeout(r, 300));
    expect(await panelShown()).toBe(true);
    expect(await agentTab()).toBe("true");
  });

  it("adding a block through the palette makes it « Non enregistré : … entrée manquante »; linking it saves it", async () => {
    await builder("add");
    await waitCount("node-tri", 1);
    // The output already exists: it is not offered.
    expect(await count("palette-sortie")).toBe(0);

    await click(m, '[data-testid="palette-list.keep"]');
    await waitCount("node-list-keep", 1);
    await waitContains("save-status", "Non enregistré : ");
    await waitContains("save-status", "entrée manquante");
    expect(await inUi(m, `return ${q("node-list-keep")}.classList.contains("in-error")`)).toBe(true);
    expect(await readWorkflow(dataDir, "add")).toEqual(WATCH_WORKFLOW);

    await link("tri", "list-keep");
    await saved();
    const written = await readWorkflow(dataDir, "add");
    expect(written.blocks.find((x: { id: string }) => x.id === "list-keep")).toMatchObject({ type: "list.keep", params: { count: 10 } });
    expect(written.links).toContainEqual({ from: "tri", to: "list-keep" });
    // The first gesture freezes the layout shown: each block now has its position.
    const positions = new Set(written.blocks.map((x: { position: { x: number; y: number } }) => `${x.position.x},${x.position.y}`));
    expect(positions.size).toBe(written.blocks.length);
  });

  it("⌘Z undoes the addition and saves again", async () => {
    await builder("undo");
    await click(m, '[data-testid="palette-list.keep"]');
    await waitCount("node-list-keep", 1);
    await link("tri", "list-keep");
    await saved();
    expect((await readWorkflow(dataDir, "undo")).blocks.map((x: { id: string }) => x.id)).toContain("list-keep");

    // Undoing the link: the block is invalid again, nothing is written.
    await pressKeys(m, "Meta+z");
    await waitContains("save-status", "entrée manquante");
    expect((await readWorkflow(dataDir, "undo")).links).toContainEqual({ from: "tri", to: "list-keep" });
    // Undoing the add: the workflow is valid again and saved again, without the block.
    await pressKeys(m, "Meta+z");
    await waitCount("node-list-keep", 0);
    await saved();
    await poll(async () => (await readWorkflow(dataDir, "undo")).blocks.map((x: { id: string }) => x.id), ["page", "liens", "tri", "textes", "sortie"]);
    // Redo does it again.
    await pressKeys(m, "Meta+Shift+z");
    await waitCount("node-list-keep", 1);
  });

  it("adding a Code block writes its .mjs file (template that returns its input) and saves the workflow", async () => {
    await builder("add-code");
    await click(m, '[data-testid="palette-code"]');
    await waitCount("node-code", 1);
    await saved();
    expect(await readFile(path.join(widgetDir(dataDir, "add-code"), "code.mjs"), "utf8")).toBe("export default async (input, ressac) => {\n  return input;\n};\n");
    const block = (await readWorkflow(dataDir, "add-code")).blocks.find((x: { id: string }) => x.id === "code");
    expect(block).toMatchObject({ type: "code", params: { source: "code.mjs" } });
  });

  it("a workflow widget's builder shows its blocks and, per block, the items of the last run; ▶ Lancer adds one", async () => {
    await home();
    const data = () => inUi<string>(m, `return doc.querySelector('[data-testid="widget-run"] iframe')?.contentDocument?.getElementById("donnees")?.textContent ?? ""`);
    await poll(data, '{"liens":["Nouveau modèle IA"]}', 20_000);
    const executions = path.join(dataOf("run"), "runs");
    expect(await readdir(executions)).toHaveLength(1);

    await openBuilder(m, "run");
    expect(Object.values((await state(m)).tabs).map((o) => o.title)).toContain("Workflow — Veille");
    await waitContains("node-tri", "Tri par Kev");
    await waitContains("node-tri", "ai.sort");
    // Two links out of the code, one after the sort.
    await waitText("pill-liens", "2");
    await waitText("pill-tri", "1");
    expect(await inUi(m, `return ${q("pill-tri")}.classList.contains("ok")`)).toBe(true);

    await waitUi(m, `return ${q("launch")}?.disabled === false`);
    await click(m, '[data-testid="launch"]');
    await poll(async () => (await readdir(executions)).length, 2, 20_000);
    await waitUi(m, `return ${q("launch")}?.disabled === false`, [], 20_000);
    const last = (await readdir(executions)).sort().at(-1)!;
    expect((await readJson(path.join(executions, last))).trigger).toBe("manual");
    // Running does not write the workflow.
    expect(await readWorkflow(dataDir, "run")).toEqual(WATCH_WORKFLOW);
  });

  it("a widget with only harvest.mjs opens as an implicit workflow (recolte → sortie) without creating a workflow.json", async () => {
    await home();
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-compte"] [data-testid="grant-banner"]')?.textContent.includes("127.0.0.1")`);
    const dir = widgetDir(dataDir, "compte");
    const before = await snapshot(dir);
    await openBuilder(m, "compte");
    await waitContains("node-harvest", "code");
    await waitContains("node-output", "output");
    await saved();
    const boxes = await inUi<Box[]>(
      m,
      "return ['harvest', 'output'].map((id) => { const r = doc.querySelector('[data-testid=\"node-' + id + '\"]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })",
    );
    expect(overlap(boxes[0]!, boxes[1]!)).toBe(false);
    await click(m, '[data-testid="node-harvest"]');
    await sleep(800);
    expect((await readdir(dir)).includes("workflow.json")).toBe(false);
    expect(await snapshot(dir)).toEqual(before);
  });

  it("an invalid workflow.json opens with its error and does not run; unreadable, it says so", async () => {
    await builder("cycle");
    await waitContains("save-status", "Non enregistré : Workflow invalide : ");
    await waitContains("save-status", "cycle");
    expect(await inUi(m, `return ${q("node-a")}.classList.contains("in-error")`)).toBe(true);
    expect(await inUi(m, `return ${q("launch")}.disabled`)).toBe(true);

    await builder("casse");
    await waitContains("workflow-unreadable", "Workflow invalide : ");
    expect(await inUi(m, `return ${q("launch")}.disabled`)).toBe(true);
  });

  it("Suppr deletes the selection but never the output", async () => {
    await builder("suppr");
    await click(m, '[data-testid="node-sortie"]');
    await pressKeys(m, "Delete");
    await sleep(300);
    expect(await count("node-sortie")).toBe(1);
    expect(await readWorkflow(dataDir, "suppr")).toEqual(WATCH_WORKFLOW);
    // With another block selected too: it alone goes (the output, without input, makes the draft invalid).
    await click(m, '[data-testid="node-textes"]');
    await keyDown(m, "Meta");
    await inUi(
      m,
      `const r = ${q("node-sortie")}.getBoundingClientRect();
       for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1, modifiers: Ci.nsIDOMWindowUtils.MODIFIER_META });`,
    );
    await keyUp(m, "Meta");
    await pressKeys(m, "Delete");
    await waitCount("node-textes", 0);
    expect(await count("node-sortie")).toBe(1);
    await waitContains("save-status", "entrée manquante");
    expect(await readWorkflow(dataDir, "suppr")).toEqual(WATCH_WORKFLOW);
  });

  it("⌘Z typed in a text field does not undo the canvas", async () => {
    await builder("field");
    await click(m, '[data-testid="palette-list.keep"]');
    await waitCount("node-list-keep", 1);
    await click(m, '[data-testid="address-bar"]');
    await typeText(m, "abc");
    await pressKeys(m, "Meta+z");
    await sleep(300);
    expect(await count("node-list-keep")).toBe(1);
    // Out of the field, ⌘Z undoes the add.
    await clickHeading();
    await pressKeys(m, "Meta+z");
    await waitCount("node-list-keep", 0);
  });

  it("the agent rewrites workflow.json during an invalid draft: banner, « Garder la mienne » then « Prendre sa version »", async () => {
    await builder("agent");
    const file = path.join(widgetDir(dataDir, "agent"), "workflow.json");
    await click(m, '[data-testid="palette-list.keep"]');
    await waitContains("save-status", "entrée manquante");

    await writeAsAgent("agent", withThreshold(0.7));
    await waitCount("file-banner", 1);
    // A gesture during the banner does not overwrite the agent's version.
    await link("tri", "list-keep");
    await sleep(500);
    expect(await count("file-banner")).toBe(1);
    expect(await thresholdOf("agent")).toBe(0.7);
    // Keep mine: my draft (linked, so valid) replaces the agent's version.
    await click(m, '[data-testid="keep-mine"]');
    await waitCount("file-banner", 0);
    await saved();
    await poll(() => thresholdOf("agent"), 0.5);
    expect((await readWorkflow(dataDir, "agent")).links).toContainEqual({ from: "tri", to: "list-keep" });

    // A new invalid draft, a new agent version: taking it drops the draft, writing nothing.
    await click(m, '[data-testid="palette-list.keep"]');
    await waitCount("node-list-keep-2", 1);
    await writeAsAgent("agent", withThreshold(0.9));
    await waitCount("file-banner", 1);
    const before = (await stat(file)).mtimeMs;
    await click(m, '[data-testid="take-version"]');
    await waitCount("file-banner", 0);
    await waitCount("node-list-keep-2", 0);
    await waitCount("node-list-keep", 0);
    await saved();
    await sleep(500);
    expect((await stat(file)).mtimeMs).toBe(before);
    expect(await thresholdOf("agent")).toBe(0.9);
  });

  it("changing ia.trier's threshold in the Bloc tab rewrites workflow.json and erases that block's memory only", async () => {
    const memory = path.join(dataOf("seuil"), "memory.json");
    await writeFile(memory, JSON.stringify({ version: 1, blocks: { tri: { type: "ai.sort", value: { seen: ["a"] } }, textes: { type: "code", value: { seen: ["b"] } } } }));
    await builder("seuil");
    // No block selected: the widget's panel, read only.
    await waitContains("widget-panel", "Pour changer les sources ou la configuration, demande-le à l'agent.");
    await waitContains("widget-config", `"url": "${site.url}/liens"`);

    await click(m, '[data-testid="node-tri"]');
    await waitValue("block-name-field", "Tri par Kev");
    expect(await inUi(m, `return doc.querySelector('[data-testid="block-pane"] [data-testid="block-id"]')?.textContent`)).toBe("tri");
    expect(await value("field-question")).toBe("Parle d'IA ?");
    // ia.trier always scores item by item: its « per item » fields are there, without a parElement box.
    expect(await count("field-onError")).toBe(1);
    expect(await count("field-perItem")).toBe(0);
    // Selecting writes nothing.
    await sleep(500);
    expect(await readWorkflow(dataDir, "seuil")).toEqual(WATCH_WORKFLOW);

    // An unreadable entry (« - ») writes nothing; left, the field shows the block's value again.
    await click(m, '[data-testid="field-threshold"]');
    await pressKeys(m, "Meta+a");
    await typeText(m, "-");
    await pressKeys(m, "Tab");
    await waitValue("field-threshold", "0.5");
    // A number is not saved while typing (« 0. » would erase the memory): Enter or focus loss.
    await fill("field-threshold", "0.7");
    await sleep(700);
    expect(await thresholdOf("seuil")).toBe(0.5);
    expect(Object.keys((await readJson(memory)).blocks)).toEqual(["tri", "textes"]);
    await pressKeys(m, "Enter");
    await poll(() => thresholdOf("seuil"), 0.7);
    await saved();
    await poll(async () => Object.keys((await readJson(memory)).blocks), ["textes"]);
    // Back to the value at focus after a save is saved too.
    await fill("field-threshold", "0.5");
    await pressKeys(m, "Tab");
    await poll(() => thresholdOf("seuil"), 0.5);
    expect(await value("field-threshold")).toBe("0.5");
    // ⌘Z (out of the field) undoes one field edit at once.
    await fill("field-threshold", "0.8");
    await pressKeys(m, "Tab");
    await poll(() => thresholdOf("seuil"), 0.8);
    await clickHeading();
    await pressKeys(m, "Meta+z");
    await poll(() => thresholdOf("seuil"), 0.5);
  });

  it("a {config.inconnu} template shows a warning and saves anyway", async () => {
    await builder("gabarit");
    await click(m, '[data-testid="node-tri"]');
    const questionOf = async () => (await readWorkflow(dataDir, "gabarit")).blocks.find((b: { id: string }) => b.id === "tri").params.question;
    await fill("field-question", "{config.inconnu} ?");
    // Saved after 400 ms without typing, keeping the focus.
    await poll(questionOf, "{config.inconnu} ?");
    await waitContains("warning-tri", "config.inconnu absent de la configuration du widget");
    expect(await inUi(m, `return ${q("node-tri")}.classList.contains("warns")`)).toBe(true);
    await saved();
    // Back to the text at focus, in the same session, is saved: the warning goes.
    await fill("field-question", "Parle d'IA ?");
    await poll(questionOf, "Parle d'IA ?");
    await waitCount("warning-tri", 0);
    // A pending entry when switching blocks is saved on its block, not on the new one.
    await fill("field-question", "Parle de cuisine ?");
    await click(m, '[data-testid="node-liens"]');
    await poll(questionOf, "Parle de cuisine ?");
    // (The first gesture froze the positions shown: only the position is added.)
    const { position: _p, ...links } = (await readWorkflow(dataDir, "gabarit")).blocks.find((b: { id: string }) => b.id === "liens");
    expect(links).toEqual(WATCH_WORKFLOW.blocks[1]);
  });

  it("a code block's code is only written with Enregistrer le code; ⌘S too", async () => {
    await builder("code");
    const code = path.join(widgetDir(dataDir, "code"), "liens.mjs");
    await click(m, '[data-testid="node-liens"]');
    await waitValue("code-editor", "export default async (page) => page.links;");
    expect(await count("code-unsaved")).toBe(0);

    await fill("code-editor", "export default async (page) => page.links.slice(0, 1);");
    await waitText("code-unsaved", "Code non enregistré");
    await sleep(800);
    expect(await readFile(code, "utf8")).toBe("export default async (page) => page.links;");
    await click(m, '[data-testid="save-code"]');
    await poll(() => readFile(code, "utf8"), "export default async (page) => page.links.slice(0, 1);");
    await waitCount("code-unsaved", 0);

    await fill("code-editor", "export default async (page) => page.links.slice(0, 2);");
    await pressKeys(m, "Meta+s");
    await poll(() => readFile(code, "utf8"), "export default async (page) => page.links.slice(0, 2);");
    await waitCount("code-unsaved", 0);
    // The workflow was not touched.
    expect(await readWorkflow(dataDir, "code")).toEqual(WATCH_WORKFLOW);

    // A draft: switching blocks asks; refused, the block stays; accepted, the draft is kept for the way back.
    await fill("code-editor", "// brouillon");
    expect(await closeHeld()).toBe(true);
    await answerConfirm(false);
    await click(m, '[data-testid="node-tri"]');
    await sleep(300);
    expect(await questions()).toHaveLength(1);
    expect(await value("block-name-field")).toBe("Liens de la page");
    await answerConfirm(true);
    await click(m, '[data-testid="node-tri"]');
    await waitValue("block-name-field", "Tri par Kev");
    await click(m, '[data-testid="node-liens"]');
    await waitValue("code-editor", "// brouillon");
    expect(await count("code-unsaved")).toBe(1);

    // The agent writes the file during the draft: banner, the draft stays shown.
    await writeFile(code, "export default async (page) => page.links; // agent");
    await waitContains("code-change", "Le fichier a changé sur le disque");
    expect(await value("code-editor")).toBe("// brouillon");
    await click(m, '[data-testid="keep-code"]');
    await waitCount("code-change", 0);

    // Closing the tab (button or ⌘W) asks too; refused, it stays; accepted, it closes and the draft is dropped.
    const builderTabs = () => inUi<number>(m, `return [...doc.querySelectorAll('[data-testid^="tab-"]')].filter((e) => e.textContent.includes("Workflow — Veille")).length`);
    const closeButton = () =>
      inUi(
        m,
        `const tab = [...doc.querySelectorAll('[data-testid^="tab-"]')].find((e) => e.textContent.includes("Workflow — Veille"));
         const b = tab.querySelector('button[aria-label="Fermer l\\'onglet"]');
         b.scrollIntoView({ block: "center" });
         const r = b.getBoundingClientRect();
         for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1 });`,
      );
    await answerConfirm(false);
    await closeButton();
    await sleep(300);
    expect(await builderTabs()).toBe(1);
    expect((await questions()).at(-1)).toContain("liens.mjs");
    const n = (await questions()).length;
    await pressKeys(m, "Meta+w");
    await poll(async () => (await questions()).length, n + 1);
    expect(await builderTabs()).toBe(1);
    await answerConfirm(true);
    await closeButton();
    await waitUi(m, `return ![...doc.querySelectorAll('[data-testid^="tab-"]')].some((e) => e.textContent.includes("Workflow — Veille"))`);
    expect(await closeHeld()).toBe(false);
    expect(await readFile(code, "utf8")).toBe("export default async (page) => page.links; // agent");
  });

  it("an output that contains <img src=x onerror=…> is displayed as text", async () => {
    const trap = '<img src=x onerror="window.piege=1">';
    const start = "2026-10-29T10:00:00.000Z";
    const id = "2026-10-29T10-00-00-000Z";
    const trace = (block: string, type: string, fields: Record<string, unknown>) => ({
      id: block,
      type,
      status: "succeeded",
      start: start,
      end: "2026-10-29T10:00:01.500Z",
      items: null,
      log: [],
      ...fields,
    });
    const dir = path.join(dataOf("img"), "runs");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        version: 1,
        id,
        owner: { type: "widget", id: "img" },
        trigger: "scheduled",
        start: start,
        end: "2026-10-29T10:00:02.000Z",
        status: "partial",
        blocks: [
          trace("page", "source.page", { output: { title: trap } }),
          trace("liens", "code", { items: 1, output: [{ text: trap, url: "https://exemple.invalid/" }], log: [trap] }),
          trace("tri", "ai.sort", { status: "failed", error: trap }),
          trace("textes", "code", { status: "not-run", start: null, end: null }),
          trace("sortie", "output", { status: "not-run", start: null, end: null }),
        ],
      }),
    );
    await builder("img");
    const images = await inUi<number>(m, "return doc.querySelectorAll('img').length");
    await waitText("pill-liens", "1");

    await click(m, '[data-testid="node-liens"]');
    const inOutput = (s: string) => `doc.querySelector('[data-testid="block-output"] ${s}')`;
    await waitUi(m, `return ${inOutput('[data-testid="block-status"]')}?.textContent.trim() === "réussi"`);
    await waitContains("block-output", "1,5 s");
    await click(m, '[data-testid="block-output"] summary', { text: "Journal (1)" });
    await waitUi(m, `return ${inOutput('[data-testid="block-log"]')}?.textContent === arguments[0]`, [trap]);
    // The output is formatted only once opened.
    expect(await count("json-output")).toBe(0);
    await click(m, '[data-testid="block-output"] [data-testid="collapsible-output"] summary');
    await waitContains("json-output", '"text": "<img src=x onerror=');

    await click(m, '[data-testid="node-tri"]');
    await waitText("block-run-error", trap);
    // The upstream output's fields (liens) and the config are offered to templates.
    await waitText("available-text", "Champs disponibles : {text} {url} {config.url}");

    expect(await inUi(m, "return doc.querySelectorAll('img').length")).toBe(images);
    expect(await inUi(m, `return doc.querySelectorAll('img[src="x"]').length`)).toBe(0);
    expect(await inUi(m, "return ui.piege === undefined")).toBe(true);
  });

  it("⌘W with unsaved code asks first", async () => {
    await builder("close");
    const code = path.join(widgetDir(dataDir, "close"), "liens.mjs");
    await click(m, '[data-testid="node-liens"]');
    await waitValue("code-editor", "export default async (page) => page.links;");
    await click(m, '[data-testid="code-editor"]');
    await pressKeys(m, "Meta+ArrowDown");
    await typeText(m, " ");
    await waitCount("code-unsaved", 1);
    const tabs = async () => Object.values((await state(m)).tabs).filter((o) => o.url === "ressac://workflow/close").length;

    // Firefox shows the sidebar's confirm() as a modal prompt (a WebDriver user prompt), with the confirm's text.
    await pressKeysLater("Meta+w");
    expect(await promptText()).toBe("Le code de liens.mjs n'est pas enregistré. Fermer quand même ? Il sera perdu.");
    await m.command("WebDriver:DismissAlert");
    expect(await tabs()).toBe(1);
    expect(await value("code-editor")).toBe("export default async (page) => page.links; ");
    expect(await count("code-unsaved")).toBe(1);

    await pressKeysLater("Meta+w");
    expect(await promptText()).toContain("liens.mjs");
    await m.command("WebDriver:AcceptAlert");
    await poll(tabs, 0);
    expect(await readFile(code, "utf8")).toBe("export default async (page) => page.links;");
  });

  it("a widget removed while its builder is open is forgotten", async () => {
    await builder("gone");
    await click(m, '[data-testid="palette-list.keep"]');
    await waitCount("node-list-keep", 1);
    await waitContains("save-status", "entrée manquante");

    // Removed from the home page, its builder tab still open behind.
    await home();
    await click(m, '[data-testid="widget-gone"] button[aria-label="Options du widget"]');
    await click(m, '[data-testid="widget-gone"] [role="menuitem"]', { text: "Retirer" });
    await click(m, '[data-testid="removal-confirmation"] button', { text: "Retirer" });
    await waitUi(m, `return !doc.querySelector('[data-testid="widget-gone"]')`);
    // The home page hides it at once; the host moves its folder to the trash, then says the home page changed.
    await waitUi(m, `return !(await ui.ressac.home.read()).widgets.some((w) => w.id === "gone")`);
    await sleep(300);
    expect(Object.values((await state(m)).tabs).some((o) => o.url === "ressac://workflow/gone")).toBe(true);

    // The agent writes a new widget under the same id, with another workflow.
    await writeWidget(dataDir, "gone", {
      name: "Veille",
      harvest: { minutes: 60 },
      declaration: { config: { url: `${site.url}/liens` } },
      workflow: {
        version: 1,
        blocks: [
          { id: "page", type: "source.page", params: { url: "{config.url}" } },
          { id: "sortie", type: "output", params: { to: "widget" } },
        ],
        links: [{ from: "page", to: "sortie" }],
      },
    });
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-gone"]')`, [], 15_000);
    await openBuilder(m, "gone");
    await waitUi(m, `const n = [...doc.querySelectorAll(".svelte-flow__node")]; return n.length === 2 && n.every((x) => x.getBoundingClientRect().width > 0)`);
    expect((await nodes(m)).sort()).toEqual(["page", "sortie"]);
    await saved();
  });
});
