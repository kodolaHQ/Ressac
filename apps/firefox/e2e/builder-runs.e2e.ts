import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inFrame, inUi, missingApi, waitUi } from "./ui";
import { openBuilder, readWorkflow, widgetDir, writeWidget } from "./workflows";

// The workflow builder's runs, replays, implicit workflows, a 30-block workflow and web widgets,
// plus a host restart under an open builder.

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
const LINKS = "export default async (page) => page.links;";
const TEXTS = "export default async (liens) => ({ liens: liens.map((l) => l.text) });";
/** The last code block waits a little: time to see the « en cours » badges and the greyed buttons. */
const SLOW_TEXTS = "export default async (liens) => { await new Promise((r) => setTimeout(r, 2500)); return { liens: liens.map((l) => l.text) }; };";

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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
/** The site's log: pages served, by query (each widget reads `/liens?<its id>`). */
const reads = new Map<string, number>();

/** The widget's data folder, outside the space (state, executions, memory). */
const dataOf = (id: string) => path.join(dataDir, "widgets", id);
const executionsOf = (id: string) => path.join(dataOf(id), "runs");
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
/** A file's content, or null if it does not exist. */
const content = (file: string) => readFile(file, "utf8").catch(() => null);
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
/** What the builder may have written in a folder: names and modification times (`recursive`: its subfolders too). */
const snapshot = async (dir: string, recursive = false) => {
  if (!existsSync(dir)) return [];
  const files = await readdir(dir, { recursive });
  return (await Promise.all(files.map(async (f) => `${f}:${(await stat(path.join(dir, f))).mtimeMs}`))).sort();
};

/** A widget on WATCH_WORKFLOW reading `/liens?<id>`; `slow`: its last code block waits 2.5 s. */
const writeWatch = (id: string, o: { slow?: boolean; declaration?: Record<string, unknown> } = {}) =>
  writeWidget(dataDir, id, {
    name: "Veille",
    harvest: { minutes: 60 },
    declaration: { config: { url: `${site.url}/liens?${id}` }, ...o.declaration },
    workflow: WATCH_WORKFLOW,
    files: { "liens.mjs": LINKS, "textes.mjs": o.slow ? SLOW_TEXTS : TEXTS, "example.json": JSON.stringify({ example: "veille" }) },
  });
/** No state: harvested at launch (scheduled). */
const dropState = (id: string) => rm(dataOf(id), { recursive: true });
const writeState = async (id: string, state: Record<string, unknown>) => {
  await mkdir(dataOf(id), { recursive: true });
  await writeFile(path.join(dataOf(id), "state.json"), JSON.stringify(state));
};

/** A run's trace of one block. */
const trace = (block: string, type: string, start: string, fields: Record<string, unknown>) => ({
  id: block,
  type,
  status: "succeeded",
  start: start,
  end: start,
  items: null,
  log: [],
  ...fields,
});
async function writeExecution(owner: string, id: string, blocks: unknown[]): Promise<void> {
  const start = id.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "T$1:$2:$3.$4Z");
  await mkdir(executionsOf(owner), { recursive: true });
  await writeFile(
    path.join(executionsOf(owner), `${id}.json`),
    JSON.stringify({ version: 1, id, owner: { type: "widget", id: owner }, trigger: "scheduled", start: start, end: start, status: "succeeded", blocks: blocks }),
  );
}

/** 30 blocks: six code sources, each followed by three lists, merged, then sorted and shaped. */
function thirtyBlocks(): { workflow: { version: number; blocks: unknown[]; links: unknown[] }; files: Record<string, string> } {
  const blocks: { id: string; type: string; params: Record<string, unknown> }[] = [];
  const links: { from: string; to: string }[] = [];
  const files: Record<string, string> = {};
  for (let i = 1; i <= 6; i++) {
    blocks.push({ id: `source-${i}`, type: "code", params: { source: `source-${i}.mjs` } });
    files[`source-${i}.mjs`] = `export default async () => [{ url: "https://exemple.invalid/${i}" }];`;
    blocks.push({ id: `nouveaux-${i}`, type: "list.new", params: { key: "url" } });
    blocks.push({ id: `dedoublonner-${i}`, type: "list.dedupe", params: { keys: ["url"] } });
    blocks.push({ id: `garder-${i}`, type: "list.keep", params: { count: 10 } });
    links.push({ from: `source-${i}`, to: `nouveaux-${i}` }, { from: `nouveaux-${i}`, to: `dedoublonner-${i}` }, { from: `dedoublonner-${i}`, to: `garder-${i}` });
    links.push({ from: `garder-${i}`, to: "fusion" });
  }
  blocks.push(
    { id: "fusion", type: "code", params: { source: "fusion.mjs" } },
    { id: "tri", type: "ai.sort", params: { question: "Parle d'IA ?", text: "{url}", threshold: 0.5 } },
    { id: "garder", type: "list.keep", params: { count: 20 } },
    { id: "dedoublonner", type: "list.dedupe", params: { keys: ["url"] } },
    { id: "forme", type: "code", params: { source: "forme.mjs" } },
    { id: "sortie", type: "output", params: { to: "widget" } },
  );
  files["fusion.mjs"] = "export default async (entrees) => Object.values(entrees).flat();";
  files["forme.mjs"] = "export default async (liens) => ({ liens });";
  links.push({ from: "fusion", to: "tri" }, { from: "tri", to: "garder" }, { from: "garder", to: "dedoublonner" }, { from: "dedoublonner", to: "forme" }, { from: "forme", to: "sortie" });
  return { workflow: { version: 1, blocks: blocks, links }, files: files };
}

const TRUNCATED = "2026-10-29T10-00-00-000Z";
const GMAIL_RUNS = ["2026-10-28T08-00-00-000Z", "2026-10-28T09-00-00-000Z"];
const SIMPLE_CODE = "export default async () => ({ bon: true });";
/** A state « up to date » whose hours tracking says all done: no hour is due during the test. */
const noHourDue = () => {
  const now = new Date().toISOString();
  return { status: "ok", lastUpdate: now, lastAttempt: now, hours: { done: "9999-12-31T23:59", failures: null } };
};

beforeAll(async () => {
  site = await listen((req, res) => {
    const query = new URL(req.url ?? "/", "http://x").search.slice(1);
    reads.set(query, (reads.get(query) ?? 0) + 1);
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

  dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-builder-runs-"));
  await writeWatch("lancer", { slow: true });
  await writeWatch("rejouer");
  await dropState("rejouer");
  await writeWatch("tronque");
  const start = "2026-10-29T10:00:00.000Z";
  await writeExecution("tronque", TRUNCATED, [
    trace("page", "source.page", start, { output: { title: "Liens" } }),
    trace("liens", "code", start, { items: 2, output: '[{"texte":"Nouveau', outputTruncated: true }),
    trace("tri", "ai.sort", start, { items: 1, output: [] }),
    trace("textes", "code", start, { output: { links: [] } }),
    trace("sortie", "output", start, { output: { links: [] } }),
  ]);
  await writeWatch("grise", { slow: true });
  await dropState("grise");
  // Like a Gmail widget: widget.json, harvest.mjs, display.html, an account, no workflow.json.
  await writeWidget(dataDir, "gmail", {
    name: "Gmail",
    harvest: { minutes: 60 },
    declaration: { sources: { account: ["127.0.0.1"], public: [] }, config: { url: `${site.url}/boite` } },
    files: {
      "harvest.mjs": "export default async (ressac) => ({ vu: (await ressac.readPage(ressac.config.url, { account: true })).title });",
      "example.json": JSON.stringify({ example: "gmail" }),
    },
  });
  // The grant is missing and was just asked: no run starts at launch.
  const now = new Date().toISOString();
  await writeState("gmail", {
    status: "grant-required",
    lastUpdate: now,
    lastAttempt: now,
    error: "Accord requis pour lire avec votre compte : 127.0.0.1",
    kernelError: true,
  });
  // Two past runs, to choose another than the last.
  for (const id of GMAIL_RUNS) {
    const d = id.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "T$1:$2:$3.$4Z");
    await writeExecution("gmail", id, [trace("harvest", "code", d, { output: { seen: id } }), trace("output", "output", d, { output: { seen: id } })]);
  }
  await writeWidget(dataDir, "simple", {
    name: "Simple",
    harvest: { minutes: 60 },
    files: { "harvest.mjs": SIMPLE_CODE, "example.json": JSON.stringify({ example: "simple" }) },
  });
  await dropState("simple");
  await writeWatch("coupe");
  const big = thirtyBlocks();
  await writeWidget(dataDir, "grand", { name: "Grand", harvest: { minutes: 60 }, workflow: big.workflow, files: big.files });
  await writeWidget(dataDir, "web", {
    name: "Veille",
    harvest: { hours: ["07:00", "19:00"], maxDurationMinutes: 30, notify: true },
    declaration: { sources: { account: [], public: [], web: true }, config: { url: `${site.url}/liens?web` } },
    workflow: WATCH_WORKFLOW,
    files: { "liens.mjs": LINKS, "textes.mjs": TEXTS },
  });
  await writeState("web", noHourDue());
  await writeWatch("sansweb");
  await writeWidget(dataDir, "fil", {
    name: "Veille",
    harvest: { minutes: 60 },
    declaration: { config: { url: `${site.url}/liens?fil` } },
    workflow: {
      version: 1,
      blocks: [
        { id: "page", type: "source.page", params: { url: "{config.url}" } },
        { id: "liens", type: "code", params: { source: "liens.mjs" } },
        { id: "garder", type: "list.keep", params: { count: 5 } },
        { id: "sortie", type: "output", params: { to: "widget", live: true } },
      ],
      links: [
        { from: "page", to: "liens" },
        { from: "liens", to: "garder" },
        { from: "garder", to: "sortie" },
      ],
    },
    files: { "liens.mjs": LINKS },
  });
  await writeWatch("relance", { slow: true });

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
  for (const o of Object.values((await state(m)).tabs)) if (o.url.startsWith("ressac://workflow/")) await dispatch(m, { type: "closeTab", id: o.id });
});

/** Back to the home page of the window. */
async function home(): Promise<void> {
  await dispatch(m, { type: "showBlankPage", windowId: (await state(m)).windows[0]!.id });
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"widget-lancer\"]')");
}

/** Home, then the builder of `id`, once its canvas has stopped moving (fitted to its blocks). */
async function builder(id: string): Promise<void> {
  await home();
  await openBuilder(m, id);
  await waitUi(
    m,
    `const n = () => JSON.stringify([...doc.querySelectorAll(".svelte-flow__node")].map((n) => n.getBoundingClientRect()));
     const now = n();
     await new Promise((r) => setTimeout(r, 150));
     return now !== "[]" && now === n();`,
  );
}

const tid = (t: string) => `[data-testid="${t}"]`;
/** `doc.querySelector(css)` in the UI script. */
const el = (css: string) => `doc.querySelector(${JSON.stringify(css)})`;
const waitTrue = (js: string, ms?: number) => waitUi(m, `return ${js}`, [], ms);
const waitText = (css: string, t: string, ms?: number) => waitTrue(`${el(css)}?.textContent.trim() === ${JSON.stringify(t)}`, ms);
const waitContains = (css: string, t: string, ms?: number) => waitTrue(`!!${el(css)}?.textContent.includes(${JSON.stringify(t)})`, ms);
const waitCount = (css: string, n: number) => waitTrue(`doc.querySelectorAll(${JSON.stringify(css)}).length === ${n}`);
/** Visible as Playwright's toBeVisible: a box, and not hidden by CSS. */
const waitVisible = (css: string) => waitTrue(`(() => { const e = ${el(css)}; if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.checkVisibility({ visibilityProperty: true }); })()`);
const waitClass = (css: string, c: string, ms?: number) => waitTrue(`!!${el(css)}?.classList.contains(${JSON.stringify(c)})`, ms);
const waitPressed = (css: string) => waitTrue(`${el(css)}?.getAttribute("aria-pressed") === "true"`);
const waitDisabled = (css: string, disabled: boolean, ms?: number) => waitTrue(`${el(css)}?.disabled === ${disabled}`, ms);
const saved = () => waitText(tid("save-status"), "Enregistré");
const textOf = (css: string) => inUi<string | null>(m, `return ${el(css)}?.textContent ?? null`);
/** The text of the `#donnees` of the frame in `css` (a home widget's or the preview's display). */
const shown = (css: string) => inFrame<string>(m, `${css} browser`, `document.getElementById("donnees")?.textContent ?? ""`).catch(() => "");
const preview = () => shown(tid("widget-preview"));
const homeData = (id: string) => shown(tid(`widget-${id}`));
const harvest = (id: string) => inUi(m, "ui.ressac.home.harvest(arguments[0])", [id]);
const runs = async (id: string) => (existsSync(executionsOf(id)) ? (await readdir(executionsOf(id))).filter((f) => f.endsWith(".json")).sort() : []);

/** A trusted mouse gesture on the centre of `css`: down, moves to (+dx, +dy) in `steps`, up. */
const drag = (css: string, dx: number, dy: number, steps: number) =>
  inUi(
    m,
    `const r = ${el(css)}.getBoundingClientRect();
     const x = r.left + r.width / 2, y = r.top + r.height / 2;
     ui.synthesizeMouseEvent("mousemove", x, y, {});
     ui.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 });
     for (let i = 1; i <= ${steps}; i++) {
       ui.synthesizeMouseEvent("mousemove", x + (${dx} * i) / ${steps}, y + (${dy} * i) / ${steps}, { button: 0, buttons: 1 });
       await new Promise((r) => requestAnimationFrame(r));
     }
     ui.synthesizeMouseEvent("mouseup", x + ${dx}, y + ${dy}, { button: 0, clickCount: 1 });`,
  );

/** Playwright's fill: clicks the field (focus), then replaces its value with one input event. */
async function fill(css: string, v: string): Promise<void> {
  await click(m, css);
  await inUi(m, `const e = ${el(css)}; e.focus(); e.value = arguments[0]; e.dispatchEvent(new ui.InputEvent("input", { bubbles: true }));`, [v]);
}
/** Enter on the focused field (trusted key). */
const pressEnter = () => m.execute(
  `const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
   tip.beginInputTransactionForTests(window);
   const ev = new KeyboardEvent("", { key: "Enter", code: "Enter" });
   tip.keydown(ev);
   tip.keyup(ev);`,
);

/** Console errors and uncaught exceptions of the sidebar UI from now on. */
// Only the sidebar's own console.error, error and unhandledrejection: unlike Playwright, not widget sub-frames or CSP reports.
const trackErrors = () =>
  inUi(
    m,
    `ui.ressacErrors = [];
     if (ui.ressacErrorsTracked) return;
     ui.ressacErrorsTracked = true;
     const error = ui.console.error.bind(ui.console);
     ui.console.error = (...a) => (ui.ressacErrors.push(a.map(String).join(" ")), error(...a));
     ui.addEventListener("error", (e) => ui.ressacErrors.push(e.message));
     ui.addEventListener("unhandledrejection", (e) => ui.ressacErrors.push(String(e.reason)));`,
  );
const errors = () => inUi<string[]>(m, "return [...ui.ressacErrors]");

/** The agent rewrites workflow.json (atomic write, like its tools). */
async function writeAsAgent(id: string, workflow: unknown): Promise<void> {
  const file = path.join(widgetDir(dataDir, id), "workflow.json");
  await writeFile(`${file}.agent`, JSON.stringify(workflow, null, 2));
  await rename(`${file}.agent`, file);
}
const thresholdOf = async (id: string) => (await readWorkflow(dataDir, id)).blocks.find((b: { id: string }) => b.id === "tri").params.threshold;
const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const agent = (body: string) => m.execute(`return (async () => { const agent = (await ChromeUtils.importESModule("${STORE}").ready).agent; ${body} })();`);

describe("the workflow builder's runs", () => {
  it("▶ Lancer: pastilles in progress then items per block, new run chosen, preview up to date", async () => {
    await home();
    await trackErrors();
    await builder("lancer");
    await waitVisible(tid("node-textes"));
    // No run: the preview shows the example, as the home page does.
    await click(m, tid("preview-button"));
    await poll(preview, '{"example":"veille"}');
    await waitCount(tid("mention-preview"), 0);

    await click(m, tid("launch"));
    await waitClass(tid("pill-textes"), "in-progress", 20_000);
    await waitText(tid("pill-liens"), "2");
    await waitDisabled(tid("launch"), true);
    await waitClass(tid("pill-textes"), "ok", 20_000);
    await waitText(tid("pill-tri"), "1");
    await waitDisabled(tid("launch"), false);
    const [id] = (await runs("lancer")).map((f) => f.replace(/\.json$/, ""));
    await waitPressed(tid(`execution-${id}`));
    await waitContains(tid(`execution-${id}`), "Manuelle");
    await waitContains(tid(`execution-${id}`), "Réussie");
    await poll(preview, '{"liens":["Nouveau modèle IA"]}');
    expect(await errors()).toEqual([]);
  });

  it("Rejouer depuis tri after changing the threshold: trial marked, page not reread, data, memory and state unchanged, trial preview", async () => {
    await home();
    // Without a state: harvested at launch (a real run, the page read once).
    await poll(() => homeData("rejouer"), '{"liens":["Nouveau modèle IA"]}', 20_000);
    const dir = dataOf("rejouer");
    const [origin] = (await runs("rejouer")).map((f) => f.replace(/\.json$/, ""));
    await builder("rejouer");
    await waitPressed(tid(`execution-${origin}`));
    // Nothing selected: nothing to replay.
    await waitDisabled(tid("replay"), true);

    await click(m, tid("node-tri"));
    const threshold = `${tid("block-pane")} ${tid("field-threshold")}`;
    await fill(threshold, "0.05");
    await pressEnter();
    await poll(() => thresholdOf("rejouer"), 0.05);
    await saved();
    const before = {
      data: await content(path.join(dir, "data.json")),
      memory: await content(path.join(dir, "memory.json")),
      state: await content(path.join(dir, "state.json")),
    };
    expect(before.data).not.toBeNull();
    const pages = reads.get("rejouer") ?? 0;
    // The harvest at launch did read the fake site: its log counts.
    expect(pages).toBeGreaterThan(0);

    await click(m, tid("replay"));
    await poll(async () => (await runs("rejouer")).length, 2, 20_000);
    const trial = (await runs("rejouer")).find((f) => f.includes("-attempt"))!.replace(/\.json$/, "");
    const button = tid(`execution-${trial}`);
    await waitContains(button, "essai");
    await waitPressed(button);
    await waitCount(tid("replay-refusal"), 0);
    await waitClass(tid("pill-liens"), "neutral");
    await waitText(tid("pill-tri"), "2");
    await click(m, tid("preview-button"));
    await poll(preview, '{"liens":["Nouveau modèle IA","Recette de cuisine"]}');
    await waitCount(tid("mention-preview"), 0);

    // tri's output, opened on the trial, stays open when the trial is read again (the origin, then the trial).
    const output = tid("block-output");
    await click(m, `${output} ${tid("collapsible-output")} summary`);
    await waitVisible(`${output} ${tid("json-output")}`);
    await click(m, tid(`execution-${origin}`));
    await waitPressed(tid(`execution-${origin}`));
    await waitCount(`${output} ${tid("json-output")}`, 0);
    await click(m, button);
    await waitPressed(button);
    await waitVisible(`${output} ${tid("json-output")}`);

    // The page was not read again; neither the data, the memory nor the widget's state moved.
    expect(reads.get("rejouer")).toBe(pages);
    expect(await content(path.join(dir, "data.json"))).toBe(before.data);
    expect(await content(path.join(dir, "memory.json"))).toBe(before.memory);
    expect(await content(path.join(dir, "state.json"))).toBe(before.state);

    // The « Exécutions » tab: all of them, the trial marked with its starting block; choosing one goes back to the canvas.
    await click(m, tid("executions-view"));
    const list = tid("executions-list");
    await waitContains(`${list} ${tid(`execution-${trial}`)}`, "essai depuis « tri »");
    await waitContains(`${list} ${tid(`execution-${origin}`)}`, "Planifiée");
    await click(m, `${list} ${tid(`execution-${origin}`)}`);
    await waitCount(list, 0);
    await waitPressed(tid(`execution-${origin}`));
    await poll(preview, '{"liens":["Nouveau modèle IA"]}');

    // Replaying twice in a row from tri, starting from the chosen trial: each time a new trial, never a refusal, and its
    // reused outputs come from the real run.
    await click(m, button);
    await waitPressed(button);
    await click(m, tid("node-tri"));
    for (const n of [3, 4]) {
      await waitDisabled(tid("replay"), false);
      await click(m, tid("replay"));
      await poll(async () => (await runs("rejouer")).length, n, 20_000);
      await waitCount(tid("replay-refusal"), 0);
      const last = (await runs("rejouer")).filter((f) => f.includes("-attempt")).at(-1)!.replace(/\.json$/, "");
      await waitPressed(tid(`execution-${last}`));
      await waitText(tid("pill-tri"), "2");
      expect((await readJson(path.join(executionsOf("rejouer"), `${last}.json`))).attempt).toEqual({ start: "tri", origin: origin });
    }
    expect(reads.get("rejouer")).toBe(pages);
  });

  it("Rejouer from a block whose upstream output is truncated: message « Rejeu impossible : … tronquée … », no run added", async () => {
    await builder("tronque");
    await waitPressed(tid(`execution-${TRUNCATED}`));
    await click(m, tid("node-tri"));
    await click(m, tid("replay"));
    await waitText(tid("replay-refusal"), "Rejeu impossible : la sortie de « liens » a été tronquée dans cette exécution");
    await sleep(500);
    expect(await runs("tronque")).toEqual([`${TRUNCATED}.json`]);
    await waitDisabled(tid("replay"), false);
  });

  it("during a run, Lancer and Rejouer are greyed out", async () => {
    await home();
    // Without a state: harvested at launch, it has a run to replay.
    await poll(() => homeData("grise"), '{"liens":["Nouveau modèle IA"]}', 20_000);
    await builder("grise");
    await click(m, tid("node-tri"));
    await waitDisabled(tid("replay"), false);
    await waitDisabled(tid("launch"), false);

    // A run started elsewhere (the agent, the home page): the builder sees it live.
    await harvest("grise");
    await waitDisabled(tid("launch"), true);
    await waitDisabled(tid("replay"), true);
    await waitClass(tid("pill-textes"), "in-progress", 20_000);
    // At the end, the view settles on the run written: no « en cours » badge any more.
    await waitDisabled(tid("launch"), false, 20_000);
    await waitDisabled(tid("replay"), false);
    await waitClass(tid("pill-textes"), "ok");
    await waitText(tid("pill-tri"), "1");
  });

  it("a widget with only harvest.mjs and an account: the builder shows recolte → sortie; opening, selecting, rearranging, choosing a run write nothing", async () => {
    const dir = widgetDir(dataDir, "gmail");
    await home();
    await trackErrors();
    await waitContains(`${tid("widget-gmail")} ${tid("grant-banner")}`, "127.0.0.1");
    // The home page settled: what it may have written at launch does not count.
    await sleep(1500);
    const before = { space: await snapshot(dir, true), data: await snapshot(dataOf("gmail"), true) };
    expect(before.data.some((f) => f.startsWith("state.json:"))).toBe(true);

    await openBuilder(m, "gmail");
    await waitContains(tid("node-harvest"), "code");
    await waitContains(tid("node-output"), "output");
    await saved();
    // The last run is chosen on opening.
    await waitPressed(tid(`execution-${GMAIL_RUNS[1]}`));

    // Selecting with a jittered click (under the 4 px drag threshold).
    await drag(tid("node-harvest"), 2, 1, 1);
    await waitVisible(tid("block-pane"));
    await click(m, tid("node-output"));
    // Reorganising, then choosing the other run.
    await click(m, tid("rearrange"));
    await click(m, tid(`execution-${GMAIL_RUNS[0]}`));
    await waitPressed(tid(`execution-${GMAIL_RUNS[0]}`));
    await sleep(1500);

    expect(existsSync(path.join(dir, "workflow.json"))).toBe(false);
    expect(await snapshot(dir, true)).toEqual(before.space);
    expect(await snapshot(dataOf("gmail"), true)).toEqual(before.data);
    expect(await errors()).toEqual([]);
  });

  it("modifying the implicit workflow creates workflow.json, keeps harvest.mjs, and the widget updates with the same data", async () => {
    const dir = widgetDir(dataDir, "simple");
    await home();
    // Without a state: harvested at launch, by harvest.mjs alone.
    await poll(() => homeData("simple"), '{"bon":true}', 20_000);
    expect(await runs("simple")).toHaveLength(1);
    expect(existsSync(path.join(dir, "workflow.json"))).toBe(false);

    await builder("simple");
    // A real gesture: moving the output by 80 px.
    await drag(tid("node-output"), 80, 40, 10);
    await poll(async () => existsSync(path.join(dir, "workflow.json")), true);
    await saved();
    const written = await readWorkflow(dataDir, "simple");
    expect(written.blocks.map((x: { id: string; type: string }) => `${x.id}:${x.type}`)).toEqual(["harvest:code", "output:output"]);
    expect(written.blocks[0].params).toMatchObject({ source: "harvest.mjs" });
    expect(written.links).toEqual([{ from: "harvest", to: "output" }]);
    expect(await readFile(path.join(dir, "harvest.mjs"), "utf8")).toBe(SIMPLE_CODE);

    // The widget now goes through workflow.json: same data.
    await click(m, tid("new-tab"));
    await poll(() => homeData("simple"), '{"bon":true}');
    await harvest("simple");
    await poll(async () => (await runs("simple")).length, 2, 20_000);
    const last = await readJson(path.join(executionsOf("simple"), (await runs("simple")).at(-1)!));
    expect(last.status).toBe("succeeded");
    expect(last.trigger).toBe("manual");
    await poll(() => homeData("simple"), '{"bon":true}');
    expect(await readJson(path.join(dataOf("simple"), "data.json"))).toEqual({ bon: true });
    expect((await readJson(path.join(dataOf("simple"), "state.json"))).status).toBe("ok");
  });

  it("the agent writes a cut-off workflow.json: the canvas stays, the banner says « illisible », the widget shows « Workflow invalide : … »", async () => {
    const file = path.join(widgetDir(dataDir, "coupe"), "workflow.json");
    await builder("coupe");
    await waitVisible(tid("node-tri"));

    // The agent writes without a temporary file: JSON cut in the middle.
    const cut = JSON.stringify(WATCH_WORKFLOW).slice(0, 120);
    await writeFile(file, cut);
    await waitContains(tid("file-banner"), "illisible");
    for (const id of ["page", "liens", "tri", "textes", "sortie"]) await waitVisible(tid(`node-${id}`));
    await waitCount(tid("workflow-unreadable"), 0);
    await sleep(500);
    // The builder did not write over it.
    expect(await readFile(file, "utf8")).toBe(cut);

    // On the home page, the next harvest says so on the widget.
    await click(m, tid("new-tab"));
    await harvest("coupe");
    await waitContains(tid("widget-coupe"), "Workflow invalide : ", 20_000);
    expect((await readJson(path.join(dataOf("coupe"), "state.json"))).error).toMatch(/^Workflow invalide : /);
  });

  it("a 30-block workflow opens readable: no node overlaps, all in view after fitView", async () => {
    expect(thirtyBlocks().workflow.blocks).toHaveLength(30);
    const before = await snapshot(widgetDir(dataDir, "grand"));
    await builder("grand");
    await saved();
    await waitCount('[data-testid^="node-"]', 30);
    await sleep(500);
    const { view, boxes } = await inUi<{ view: Box; boxes: Box[] }>(
      m,
      `const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
       return { view: box(doc.querySelector(".svelte-flow")), boxes: [...doc.querySelectorAll('[data-testid^="node-"]')].map(box) };`,
    );
    for (const [i, a] of boxes.entries()) {
      expect(a.x, `node ${i} left of the view`).toBeGreaterThanOrEqual(view.x);
      expect(a.y, `node ${i} above the view`).toBeGreaterThanOrEqual(view.y);
      expect(a.x + a.width, `node ${i} right of the view`).toBeLessThanOrEqual(view.x + view.width);
      expect(a.y + a.height, `node ${i} below the view`).toBeLessThanOrEqual(view.y + view.height);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i]!, boxes[j]!), `nodes ${i} and ${j}`).toBe(false);
    // Laid out on opening without writing anything.
    expect(await snapshot(widgetDir(dataDir, "grand"))).toEqual(before);
  });

  it("the Widget panel of a web widget shows « Accès au web : ouvert » and its hours; Chercher sur le web is added from the palette", async () => {
    const declaration = await readFile(path.join(widgetDir(dataDir, "web"), "widget.json"), "utf8");
    await builder("web");
    const panel = tid("widget-panel");
    await waitText(tid("widget-web"), "Accès au web : ouvert");
    await waitText(tid("widget-hours"), "Heures prévues : 07:00, 19:00");
    await waitContains(panel, "Durée maximale : 30 min");
    await waitContains(panel, "Notification à la fin : oui");

    const search = tid("palette-web.search");
    await waitDisabled(search, false);
    await click(m, search);
    await waitVisible(tid("node-web-search"));
    await waitTrue(`!${el(tid("save-status"))}.textContent.includes("doit déclarer")`);
    // widget.json is never written by the builder.
    expect(await readFile(path.join(widgetDir(dataDir, "web"), "widget.json"), "utf8")).toBe(declaration);
  });

  it("in a widget without web, Chercher sur le web is greyed out; a web.chercher written by the agent renders « Non enregistré » / « Workflow invalide : web.chercher … »", async () => {
    await builder("sansweb");
    await waitVisible(tid("node-tri"));
    // Nothing about the web in the panel of a widget without access.
    await waitCount(tid("widget-web"), 0);
    await waitCount(tid("widget-hours"), 0);
    const search = tid("palette-web.search");
    await waitDisabled(search, true);
    expect(await inUi(m, `return ${el(search)}.getAttribute("title")`)).toBe('Le widget doit déclarer "web": true : demandez-le à l\'agent.');
    // Playwright's force click: the mouse on a disabled button.
    await click(m, search, { force: true });
    await sleep(300);
    await waitCount(tid("node-web-search"), 0);

    await writeAsAgent("sansweb", {
      version: 1,
      blocks: [
        { id: "chercher", type: "web.search", params: { query: "voitures" } },
        { id: "sortie", type: "output", params: { to: "widget" } },
      ],
      links: [{ from: "chercher", to: "sortie" }],
    });
    await waitVisible(tid("node-chercher"));
    await waitContains(tid("save-status"), "Non enregistré : ");
    await waitContains(tid("save-status"), 'Workflow invalide : web.search : le widget doit déclarer "web": true');
  });

  it("streaming behind Garder les N premiers: warning on the output", async () => {
    await builder("fil");
    await click(m, tid("node-sortie"));
    await waitContains(tid("warning-sortie"), "rien à publier au fil de l'eau : l'entrée de la sortie n'est pas traitée élément par élément");
    await waitClass(tid("node-sortie"), "warns");
    await saved();

    // Unchecked, the box removes the key (absent = false): nothing else is written in the output.
    const box = tid("field-live");
    await waitTrue(`${el(box)}?.checked === true`);
    await click(m, box);
    await poll(async () => (await readWorkflow(dataDir, "fil")).blocks.find((b: { id: string }) => b.id === "sortie").params, { to: "widget" });
    await waitCount(tid("warning-sortie"), 0);
  });

  it("the builder keeps working after a host restart", async () => {
    await builder("relance");
    await waitVisible(tid("node-textes"));
    // The host stops under the open builder (as home.e2e.ts does), then starts again (the agent panel's Réessayer).
    await agent("await agent.stop();");
    await waitFor<number | null>(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`, (pid) => pid === null);
    await agent("await agent.ensure();");

    await waitDisabled(tid("launch"), false);
    await click(m, tid("launch"));
    await waitClass(tid("pill-textes"), "in-progress", 20_000);
    await waitDisabled(tid("launch"), true);
    await waitClass(tid("pill-textes"), "ok", 20_000);
    await waitText(tid("pill-tri"), "1");
    await waitDisabled(tid("launch"), false);
    const all = await runs("relance");
    expect(all).toHaveLength(1);
    await waitPressed(tid(`execution-${all[0]!.replace(/\.json$/, "")}`));
    expect(await textOf(tid(`execution-${all[0]!.replace(/\.json$/, "")}`))).toContain("Manuelle");
  });
});
