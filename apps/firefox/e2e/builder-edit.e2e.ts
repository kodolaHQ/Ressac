import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, keyDown, keyUp, missingApi, pressKeys, typeText, waitUi } from "./ui";
import { nodes, openBuilder, readWorkflow, widgetDir, writeWidget } from "./workflows";

// The workflow builder on webaios://workflow/<widget>, opened from the home page's widget menu.

/** A workflow shipped by the agent, without positions: a page, its links taken by code, sorted by Kev, then their texts. */
const WATCH_WORKFLOW = {
  version: 1,
  blocs: [
    { id: "page", type: "source.page", parametres: { url: "{config.url}" } },
    { id: "liens", type: "code", nom: "Liens de la page", parametres: { source: "liens.mjs" } },
    { id: "tri", type: "ia.trier", nom: "Tri par Kev", parametres: { question: "Parle d'IA ?", texte: "{texte}", seuil: 0.5 } },
    { id: "textes", type: "code", parametres: { source: "textes.mjs" } },
    { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
  ],
  liens: [
    { de: "page", vers: "liens" },
    { de: "liens", vers: "tri" },
    { de: "tri", vers: "textes" },
    { de: "textes", vers: "sortie" },
  ],
};

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** What the builder may have written in a widget's folder: names and modification times. */
const snapshot = async (dir: string) => (await Promise.all((await readdir(dir)).map(async (f) => `${f}:${(await stat(path.join(dir, f))).mtimeMs}`))).sort();

let dataDir: string;
let w: LaunchedWebAiOs;
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

/** The widgets built on WORKFLOW_VEILLE, one per test that edits it (a builder keeps its draft per widget for the window). */
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
    nom: "Veille",
    recolte: { minutes: 60 },
    declaration: { config: { url: `${site.url}/liens` } },
    workflow: WATCH_WORKFLOW,
    fichiers: {
      "liens.mjs": "export default async (page) => page.liens;",
      "textes.mjs": "export default async (liens) => ({ liens: liens.map((l) => l.texte) });",
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

  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-builder-"));
  await writeWidget(dataDir, "veille", {
    nom: "Veille",
    recolte: { minutes: 60 },
    declaration: { config: { url: "https://exemple.invalid/liens" } },
    workflow: WATCH_WORKFLOW,
    fichiers: {
      "liens.mjs": "export default async (page) => page.liens;",
      "textes.mjs": "export default async (liens) => ({ liens: liens.map((l) => l.texte) });",
    },
  });
  await writeWidget(dataDir, "sans", { nom: "Sans récolte" });
  for (const id of WATCHES) await writeWatch(id);
  // Without a state: harvested at launch (scheduled).
  await rm(dataOf("run"), { recursive: true });
  // Only recolte.mjs: an implicit workflow (recolte → sortie).
  await writeWidget(dataDir, "compte", {
    nom: "Compte",
    recolte: { minutes: 60 },
    declaration: { sources: { compte: ["127.0.0.1"], publiques: [], web: false }, config: { url: `${site.url}/lire-cookie?compte` } },
    fichiers: { "recolte.mjs": "export default async (webaios) => ({ vu: (await webaios.lirePage(webaios.config.url, { compte: true })).titre });" },
  });
  await rm(dataOf("compte"), { recursive: true });
  await writeWidget(dataDir, "casse", { nom: "Cassé", recolte: { minutes: 60 }, workflow: '{ "version": 1, "blocs": [ { "id": "page", "type": "source.pa' });
  await writeWidget(dataDir, "cycle", {
    nom: "Cycle",
    recolte: { minutes: 60 },
    workflow: {
      version: 1,
      blocs: [
        { id: "a", type: "liste.garder", parametres: { nombre: 1 } },
        { id: "b", type: "liste.garder", parametres: { nombre: 1 } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [
        { de: "a", vers: "b" },
        { de: "b", vers: "a" },
        { de: "b", vers: "sortie" },
      ],
    },
  });
  w = await launchWebAiOs({ dataDir, height: 1400, env: { WEBAIOS_KEV_URL: kev.url, WEBAIOS_OLLAMA_URL: ollama.url, WEBAIOS_TEST_ADRESSES_LOCALES: "1" } });
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
  for (const o of Object.values((await state(m)).onglets)) if (o.url.startsWith("webaios://workflow/")) await dispatch(m, { type: "fermerOnglet", id: o.id });
});

/** Back to the home page of the window. */
async function home(): Promise<void> {
  await dispatch(m, { type: "afficherPageVide", fenetreId: (await state(m)).fenetres[0]!.id });
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
const saved = () => waitText("etat-enregistrement", "Enregistré");

/** Drags a link from block `from`'s output to block `to`'s input (trusted mouse events, in steps). */
async function link(from: string, to: string): Promise<void> {
  await inUi(
    m,
    `const centre = (s) => { const r = doc.querySelector(s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
     const ends = () => [...centre('[data-testid="noeud-' + arguments[0] + '"] .svelte-flow__handle.source'), ...centre('[data-testid="noeud-' + arguments[1] + '"] .svelte-flow__handle.target')];
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
const clickHeading = () => click(m, '[data-testid="constructeur"] h1');

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
  blocs: WATCH_WORKFLOW.blocs.map((b) => (b.id === "tri" ? { ...b, parametres: { ...b.parametres, seuil: threshold } } : b)),
});
const thresholdOf = async (id: string) => (await readWorkflow(dataDir, id)).blocs.find((b: { id: string }) => b.id === "tri").parametres.seuil;

describe("the workflow builder", () => {
  it("opening the builder of a shipped workflow without positions lays it out in columns and writes nothing", async () => {
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"widget-veille\"] iframe')");
    const before = await snapshot(widgetDir(dataDir, "veille"));
    await openBuilder(m, "veille");
    await waitUi(m, "return doc.querySelector('[data-testid=\"constructeur\"] h1')?.textContent === 'Veille'");
    const ids = ["page", "liens", "tri", "textes", "sortie"];
    expect((await waitUi<string[] | false>(m, "const n = [...doc.querySelectorAll('.svelte-flow__node')]; return n.length === 5 && n.map((x) => x.dataset.id)")) as string[]).toEqual(
      expect.arrayContaining(ids),
    );
    expect((await nodes(m)).sort()).toEqual([...ids].sort());
    const boxes = await inUi<Box[]>(
      m,
      "return arguments[0].map((id) => { const r = doc.querySelector('[data-testid=\"noeud-' + id + '\"]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })",
      [ids],
    );
    const liens = await inUi<string>(m, "return doc.querySelector('[data-testid=\"noeud-liens\"]').textContent");
    expect(liens).toContain("Liens de la page");
    expect(liens).toContain("code");
    // One column per rank, left to right, no overlap.
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x + boxes[i - 1]!.width / 2);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i]!, boxes[j]!)).toBe(false);
    expect(await waitUi(m, "return doc.querySelector('[data-testid=\"etat-enregistrement\"]')?.textContent.trim() === 'Enregistré'")).toBe(true);

    // Selecting and reorganising write nothing either.
    await click(m, '[data-testid="noeud-tri"]');
    await click(m, '[data-testid="reorganiser"]');
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
    const tabs = Object.values((await state(m)).onglets).filter((o) => o.url === "webaios://workflow/veille");
    expect(tabs.map((o) => o.titre)).toEqual(["Workflow — Veille"]);
  });

  it("⌘J and ✦ on a builder tab show its Agent tab and open the agent panel, never closing it", async () => {
    await home();
    await openBuilder(m, "veille");
    const panelShown = () => m.execute<boolean>("return !document.getElementById('webaios-agent').hidden");
    const agentTab = () => inUi<string | null>(m, "return doc.querySelector('[data-testid=\"onglet-agent\"]')?.getAttribute('aria-selected')");
    // Leaving the home page closed the panel it had opened.
    await waitFor(m, "return document.getElementById('webaios-agent').hidden", (v) => v === true);
    expect(await agentTab()).toBe("false");
    await pressKeys(m, "Meta+j");
    await waitFor(m, "return !document.getElementById('webaios-agent').hidden", (v) => v === true);
    expect(await waitUi(m, "return doc.querySelector('[data-testid=\"onglet-agent\"]')?.getAttribute('aria-selected') === 'true'")).toBe(true);
    expect(await m.execute("return document.activeElement?.id")).toBe("webaios-agent");
    await pressKeys(m, "Meta+j");
    await click(m, '[data-testid="bouton-agent"]');
    await new Promise((r) => setTimeout(r, 300));
    expect(await panelShown()).toBe(true);
    expect(await agentTab()).toBe("true");
  });

  it("adding a block through the palette makes it « Non enregistré : … entrée manquante »; linking it saves it", async () => {
    await builder("add");
    await waitCount("noeud-tri", 1);
    // The output already exists: it is not offered.
    expect(await count("palette-sortie")).toBe(0);

    await click(m, '[data-testid="palette-liste.garder"]');
    await waitCount("noeud-liste-garder", 1);
    await waitContains("etat-enregistrement", "Non enregistré : ");
    await waitContains("etat-enregistrement", "entrée manquante");
    expect(await inUi(m, `return ${q("noeud-liste-garder")}.classList.contains("en-erreur")`)).toBe(true);
    expect(await readWorkflow(dataDir, "add")).toEqual(WATCH_WORKFLOW);

    await link("tri", "liste-garder");
    await saved();
    const written = await readWorkflow(dataDir, "add");
    expect(written.blocs.find((x: { id: string }) => x.id === "liste-garder")).toMatchObject({ type: "liste.garder", parametres: { nombre: 10 } });
    expect(written.liens).toContainEqual({ de: "tri", vers: "liste-garder" });
    // The first gesture freezes the layout shown: each block now has its position.
    const positions = new Set(written.blocs.map((x: { position: { x: number; y: number } }) => `${x.position.x},${x.position.y}`));
    expect(positions.size).toBe(written.blocs.length);
  });

  it("⌘Z undoes the addition and saves again", async () => {
    await builder("undo");
    await click(m, '[data-testid="palette-liste.garder"]');
    await waitCount("noeud-liste-garder", 1);
    await link("tri", "liste-garder");
    await saved();
    expect((await readWorkflow(dataDir, "undo")).blocs.map((x: { id: string }) => x.id)).toContain("liste-garder");

    // Undoing the link: the block is invalid again, nothing is written.
    await pressKeys(m, "Meta+z");
    await waitContains("etat-enregistrement", "entrée manquante");
    expect((await readWorkflow(dataDir, "undo")).liens).toContainEqual({ de: "tri", vers: "liste-garder" });
    // Undoing the add: the workflow is valid again and saved again, without the block.
    await pressKeys(m, "Meta+z");
    await waitCount("noeud-liste-garder", 0);
    await saved();
    await poll(async () => (await readWorkflow(dataDir, "undo")).blocs.map((x: { id: string }) => x.id), ["page", "liens", "tri", "textes", "sortie"]);
    // Redo does it again.
    await pressKeys(m, "Meta+Shift+z");
    await waitCount("noeud-liste-garder", 1);
  });

  it("adding a Code block writes its .mjs file (template that returns its input) and saves the workflow", async () => {
    await builder("add-code");
    await click(m, '[data-testid="palette-code"]');
    await waitCount("noeud-code", 1);
    await saved();
    expect(await readFile(path.join(widgetDir(dataDir, "add-code"), "code.mjs"), "utf8")).toBe("export default async (entree, webaios) => {\n  return entree;\n};\n");
    const block = (await readWorkflow(dataDir, "add-code")).blocs.find((x: { id: string }) => x.id === "code");
    expect(block).toMatchObject({ type: "code", parametres: { source: "code.mjs" } });
  });

  it("a workflow widget's builder shows its blocks and, per block, the items of the last run; ▶ Lancer adds one", async () => {
    await home();
    const data = () => inUi<string>(m, `return doc.querySelector('[data-testid="widget-run"] iframe')?.contentDocument?.getElementById("donnees")?.textContent ?? ""`);
    await poll(data, '{"liens":["Nouveau modèle IA"]}', 20_000);
    const executions = path.join(dataOf("run"), "executions");
    expect(await readdir(executions)).toHaveLength(1);

    await openBuilder(m, "run");
    expect(Object.values((await state(m)).onglets).map((o) => o.titre)).toContain("Workflow — Veille");
    await waitContains("noeud-tri", "Tri par Kev");
    await waitContains("noeud-tri", "ia.trier");
    // Two links out of the code, one after the sort.
    await waitText("pastille-liens", "2");
    await waitText("pastille-tri", "1");
    expect(await inUi(m, `return ${q("pastille-tri")}.classList.contains("ok")`)).toBe(true);

    await waitUi(m, `return ${q("lancer")}?.disabled === false`);
    await click(m, '[data-testid="lancer"]');
    await poll(async () => (await readdir(executions)).length, 2, 20_000);
    await waitUi(m, `return ${q("lancer")}?.disabled === false`, [], 20_000);
    const last = (await readdir(executions)).sort().at(-1)!;
    expect((await readJson(path.join(executions, last))).declencheur).toBe("manuelle");
    // Running does not write the workflow.
    expect(await readWorkflow(dataDir, "run")).toEqual(WATCH_WORKFLOW);
  });

  it("a widget with only recolte.mjs opens as an implicit workflow (recolte → sortie) without creating a workflow.json", async () => {
    await home();
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-compte"] [data-testid="bandeau-accord"]')?.textContent.includes("127.0.0.1")`);
    const dir = widgetDir(dataDir, "compte");
    const before = await snapshot(dir);
    await openBuilder(m, "compte");
    await waitContains("noeud-recolte", "code");
    await waitContains("noeud-sortie", "sortie");
    await saved();
    const boxes = await inUi<Box[]>(
      m,
      "return ['recolte', 'sortie'].map((id) => { const r = doc.querySelector('[data-testid=\"noeud-' + id + '\"]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })",
    );
    expect(overlap(boxes[0]!, boxes[1]!)).toBe(false);
    await click(m, '[data-testid="noeud-recolte"]');
    await sleep(800);
    expect((await readdir(dir)).includes("workflow.json")).toBe(false);
    expect(await snapshot(dir)).toEqual(before);
  });

  it("an invalid workflow.json opens with its error and does not run; unreadable, it says so", async () => {
    await builder("cycle");
    await waitContains("etat-enregistrement", "Non enregistré : Workflow invalide : ");
    await waitContains("etat-enregistrement", "cycle");
    expect(await inUi(m, `return ${q("noeud-a")}.classList.contains("en-erreur")`)).toBe(true);
    expect(await inUi(m, `return ${q("lancer")}.disabled`)).toBe(true);

    await builder("casse");
    await waitContains("workflow-illisible", "Workflow invalide : ");
    expect(await inUi(m, `return ${q("lancer")}.disabled`)).toBe(true);
  });

  it("Suppr deletes the selection but never the output", async () => {
    await builder("suppr");
    await click(m, '[data-testid="noeud-sortie"]');
    await pressKeys(m, "Delete");
    await sleep(300);
    expect(await count("noeud-sortie")).toBe(1);
    expect(await readWorkflow(dataDir, "suppr")).toEqual(WATCH_WORKFLOW);
    // With another block selected too: it alone goes (the output, without input, makes the draft invalid).
    await click(m, '[data-testid="noeud-textes"]');
    await keyDown(m, "Meta");
    await inUi(
      m,
      `const r = ${q("noeud-sortie")}.getBoundingClientRect();
       for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1, modifiers: Ci.nsIDOMWindowUtils.MODIFIER_META });`,
    );
    await keyUp(m, "Meta");
    await pressKeys(m, "Delete");
    await waitCount("noeud-textes", 0);
    expect(await count("noeud-sortie")).toBe(1);
    await waitContains("etat-enregistrement", "entrée manquante");
    expect(await readWorkflow(dataDir, "suppr")).toEqual(WATCH_WORKFLOW);
  });

  it("⌘Z typed in a text field does not undo the canvas", async () => {
    await builder("field");
    await click(m, '[data-testid="palette-liste.garder"]');
    await waitCount("noeud-liste-garder", 1);
    await click(m, '[data-testid="barre-adresse"]');
    await typeText(m, "abc");
    await pressKeys(m, "Meta+z");
    await sleep(300);
    expect(await count("noeud-liste-garder")).toBe(1);
    // Out of the field, ⌘Z undoes the add.
    await clickHeading();
    await pressKeys(m, "Meta+z");
    await waitCount("noeud-liste-garder", 0);
  });

  it("the agent rewrites workflow.json during an invalid draft: banner, « Garder la mienne » then « Prendre sa version »", async () => {
    await builder("agent");
    const file = path.join(widgetDir(dataDir, "agent"), "workflow.json");
    await click(m, '[data-testid="palette-liste.garder"]');
    await waitContains("etat-enregistrement", "entrée manquante");

    await writeAsAgent("agent", withThreshold(0.7));
    await waitCount("bandeau-fichier", 1);
    // A gesture during the banner does not overwrite the agent's version.
    await link("tri", "liste-garder");
    await sleep(500);
    expect(await count("bandeau-fichier")).toBe(1);
    expect(await thresholdOf("agent")).toBe(0.7);
    // Keep mine: my draft (linked, so valid) replaces the agent's version.
    await click(m, '[data-testid="garder-mienne"]');
    await waitCount("bandeau-fichier", 0);
    await saved();
    await poll(() => thresholdOf("agent"), 0.5);
    expect((await readWorkflow(dataDir, "agent")).liens).toContainEqual({ de: "tri", vers: "liste-garder" });

    // A new invalid draft, a new agent version: taking it drops the draft, writing nothing.
    await click(m, '[data-testid="palette-liste.garder"]');
    await waitCount("noeud-liste-garder-2", 1);
    await writeAsAgent("agent", withThreshold(0.9));
    await waitCount("bandeau-fichier", 1);
    const before = (await stat(file)).mtimeMs;
    await click(m, '[data-testid="prendre-version"]');
    await waitCount("bandeau-fichier", 0);
    await waitCount("noeud-liste-garder-2", 0);
    await waitCount("noeud-liste-garder", 0);
    await saved();
    await sleep(500);
    expect((await stat(file)).mtimeMs).toBe(before);
    expect(await thresholdOf("agent")).toBe(0.9);
  });

  it("changing ia.trier's threshold in the Bloc tab rewrites workflow.json and erases that block's memory only", async () => {
    const memory = path.join(dataOf("seuil"), "memoire.json");
    await writeFile(memory, JSON.stringify({ version: 1, blocs: { tri: { type: "ia.trier", valeur: { vus: ["a"] } }, textes: { type: "code", valeur: { vus: ["b"] } } } }));
    await builder("seuil");
    // No block selected: the widget's panel, read only.
    await waitContains("panneau-widget", "Pour changer les sources ou la configuration, demande-le à l'agent.");
    await waitContains("widget-config", `"url": "${site.url}/liens"`);

    await click(m, '[data-testid="noeud-tri"]');
    await waitValue("nom-bloc", "Tri par Kev");
    expect(await inUi(m, `return doc.querySelector('[data-testid="volet-bloc"] [data-testid="id-bloc"]')?.textContent`)).toBe("tri");
    expect(await value("champ-question")).toBe("Parle d'IA ?");
    // ia.trier always scores item by item: its « per item » fields are there, without a parElement box.
    expect(await count("champ-siErreur")).toBe(1);
    expect(await count("champ-parElement")).toBe(0);
    // Selecting writes nothing.
    await sleep(500);
    expect(await readWorkflow(dataDir, "seuil")).toEqual(WATCH_WORKFLOW);

    // An unreadable entry (« - ») writes nothing; left, the field shows the block's value again.
    await click(m, '[data-testid="champ-seuil"]');
    await pressKeys(m, "Meta+a");
    await typeText(m, "-");
    await pressKeys(m, "Tab");
    await waitValue("champ-seuil", "0.5");
    // A number is not saved while typing (« 0. » would erase the memory): Enter or focus loss.
    await fill("champ-seuil", "0.7");
    await sleep(700);
    expect(await thresholdOf("seuil")).toBe(0.5);
    expect(Object.keys((await readJson(memory)).blocs)).toEqual(["tri", "textes"]);
    await pressKeys(m, "Enter");
    await poll(() => thresholdOf("seuil"), 0.7);
    await saved();
    await poll(async () => Object.keys((await readJson(memory)).blocs), ["textes"]);
    // Back to the value at focus after a save is saved too.
    await fill("champ-seuil", "0.5");
    await pressKeys(m, "Tab");
    await poll(() => thresholdOf("seuil"), 0.5);
    expect(await value("champ-seuil")).toBe("0.5");
    // ⌘Z (out of the field) undoes one field edit at once.
    await fill("champ-seuil", "0.8");
    await pressKeys(m, "Tab");
    await poll(() => thresholdOf("seuil"), 0.8);
    await clickHeading();
    await pressKeys(m, "Meta+z");
    await poll(() => thresholdOf("seuil"), 0.5);
  });

  it("a {config.inconnu} template shows a warning and saves anyway", async () => {
    await builder("gabarit");
    await click(m, '[data-testid="noeud-tri"]');
    const questionOf = async () => (await readWorkflow(dataDir, "gabarit")).blocs.find((b: { id: string }) => b.id === "tri").parametres.question;
    await fill("champ-question", "{config.inconnu} ?");
    // Saved after 400 ms without typing, keeping the focus.
    await poll(questionOf, "{config.inconnu} ?");
    await waitContains("avertissement-tri", "config.inconnu absent de la configuration du widget");
    expect(await inUi(m, `return ${q("noeud-tri")}.classList.contains("avertit")`)).toBe(true);
    await saved();
    // Back to the text at focus, in the same session, is saved: the warning goes.
    await fill("champ-question", "Parle d'IA ?");
    await poll(questionOf, "Parle d'IA ?");
    await waitCount("avertissement-tri", 0);
    // A pending entry when switching blocks is saved on its block, not on the new one.
    await fill("champ-question", "Parle de cuisine ?");
    await click(m, '[data-testid="noeud-liens"]');
    await poll(questionOf, "Parle de cuisine ?");
    // (The first gesture froze the positions shown: only the position is added.)
    const { position: _p, ...liens } = (await readWorkflow(dataDir, "gabarit")).blocs.find((b: { id: string }) => b.id === "liens");
    expect(liens).toEqual(WATCH_WORKFLOW.blocs[1]);
  });

  it("a code block's code is only written with Enregistrer le code; ⌘S too", async () => {
    await builder("code");
    const code = path.join(widgetDir(dataDir, "code"), "liens.mjs");
    await click(m, '[data-testid="noeud-liens"]');
    await waitValue("editeur-code", "export default async (page) => page.liens;");
    expect(await count("code-non-enregistre")).toBe(0);

    await fill("editeur-code", "export default async (page) => page.liens.slice(0, 1);");
    await waitText("code-non-enregistre", "Code non enregistré");
    await sleep(800);
    expect(await readFile(code, "utf8")).toBe("export default async (page) => page.liens;");
    await click(m, '[data-testid="enregistrer-code"]');
    await poll(() => readFile(code, "utf8"), "export default async (page) => page.liens.slice(0, 1);");
    await waitCount("code-non-enregistre", 0);

    await fill("editeur-code", "export default async (page) => page.liens.slice(0, 2);");
    await pressKeys(m, "Meta+s");
    await poll(() => readFile(code, "utf8"), "export default async (page) => page.liens.slice(0, 2);");
    await waitCount("code-non-enregistre", 0);
    // The workflow was not touched.
    expect(await readWorkflow(dataDir, "code")).toEqual(WATCH_WORKFLOW);

    // A draft: switching blocks asks; refused, the block stays; accepted, the draft is kept for the way back.
    await fill("editeur-code", "// brouillon");
    expect(await closeHeld()).toBe(true);
    await answerConfirm(false);
    await click(m, '[data-testid="noeud-tri"]');
    await sleep(300);
    expect(await questions()).toHaveLength(1);
    expect(await value("nom-bloc")).toBe("Liens de la page");
    await answerConfirm(true);
    await click(m, '[data-testid="noeud-tri"]');
    await waitValue("nom-bloc", "Tri par Kev");
    await click(m, '[data-testid="noeud-liens"]');
    await waitValue("editeur-code", "// brouillon");
    expect(await count("code-non-enregistre")).toBe(1);

    // The agent writes the file during the draft: banner, the draft stays shown.
    await writeFile(code, "export default async (page) => page.liens; // agent");
    await waitContains("code-change", "Le fichier a changé sur le disque");
    expect(await value("editeur-code")).toBe("// brouillon");
    await click(m, '[data-testid="garder-code"]');
    await waitCount("code-change", 0);

    // Closing the tab (button or ⌘W) asks too; refused, it stays; accepted, it closes and the draft is dropped.
    const builderTabs = () => inUi<number>(m, `return [...doc.querySelectorAll('[data-testid^="onglet-"]')].filter((e) => e.textContent.includes("Workflow — Veille")).length`);
    const closeButton = () =>
      inUi(
        m,
        `const tab = [...doc.querySelectorAll('[data-testid^="onglet-"]')].find((e) => e.textContent.includes("Workflow — Veille"));
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
    await waitUi(m, `return ![...doc.querySelectorAll('[data-testid^="onglet-"]')].some((e) => e.textContent.includes("Workflow — Veille"))`);
    expect(await closeHeld()).toBe(false);
    expect(await readFile(code, "utf8")).toBe("export default async (page) => page.liens; // agent");
  });

  it("an output that contains <img src=x onerror=…> is displayed as text", async () => {
    const trap = '<img src=x onerror="window.piege=1">';
    const start = "2026-10-29T10:00:00.000Z";
    const id = "2026-10-29T10-00-00-000Z";
    const trace = (block: string, type: string, fields: Record<string, unknown>) => ({
      id: block,
      type,
      statut: "reussi",
      debut: start,
      fin: "2026-10-29T10:00:01.500Z",
      elements: null,
      journal: [],
      ...fields,
    });
    const dir = path.join(dataOf("img"), "executions");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        version: 1,
        id,
        proprietaire: { type: "widget", id: "img" },
        declencheur: "planifiee",
        debut: start,
        fin: "2026-10-29T10:00:02.000Z",
        statut: "partielle",
        blocs: [
          trace("page", "source.page", { sortie: { titre: trap } }),
          trace("liens", "code", { elements: 1, sortie: [{ texte: trap, url: "https://exemple.invalid/" }], journal: [trap] }),
          trace("tri", "ia.trier", { statut: "echoue", erreur: trap }),
          trace("textes", "code", { statut: "pas-lance", debut: null, fin: null }),
          trace("sortie", "sortie", { statut: "pas-lance", debut: null, fin: null }),
        ],
      }),
    );
    await builder("img");
    const images = await inUi<number>(m, "return doc.querySelectorAll('img').length");
    await waitText("pastille-liens", "1");

    await click(m, '[data-testid="noeud-liens"]');
    const inOutput = (s: string) => `doc.querySelector('[data-testid="sortie-bloc"] ${s}')`;
    await waitUi(m, `return ${inOutput('[data-testid="statut-bloc"]')}?.textContent.trim() === "réussi"`);
    await waitContains("sortie-bloc", "1,5 s");
    await click(m, '[data-testid="sortie-bloc"] summary', { text: "Journal (1)" });
    await waitUi(m, `return ${inOutput('[data-testid="journal-bloc"]')}?.textContent === arguments[0]`, [trap]);
    // The output is formatted only once opened.
    expect(await count("sortie-json")).toBe(0);
    await click(m, '[data-testid="sortie-bloc"] [data-testid="sortie-repliable"] summary');
    await waitContains("sortie-json", '"texte": "<img src=x onerror=');

    await click(m, '[data-testid="noeud-tri"]');
    await waitText("erreur-bloc", trap);
    // The upstream output's fields (liens) and the config are offered to templates.
    await waitText("disponibles-texte", "Champs disponibles : {texte} {url} {config.url}");

    expect(await inUi(m, "return doc.querySelectorAll('img').length")).toBe(images);
    expect(await inUi(m, `return doc.querySelectorAll('img[src="x"]').length`)).toBe(0);
    expect(await inUi(m, "return ui.piege === undefined")).toBe(true);
  });

  it("⌘W with unsaved code asks first", async () => {
    await builder("close");
    const code = path.join(widgetDir(dataDir, "close"), "liens.mjs");
    await click(m, '[data-testid="noeud-liens"]');
    await waitValue("editeur-code", "export default async (page) => page.liens;");
    await click(m, '[data-testid="editeur-code"]');
    await pressKeys(m, "Meta+ArrowDown");
    await typeText(m, " ");
    await waitCount("code-non-enregistre", 1);
    const tabs = async () => Object.values((await state(m)).onglets).filter((o) => o.url === "webaios://workflow/close").length;

    // Firefox shows the sidebar's confirm() as a modal prompt (a WebDriver user prompt), with the confirm's text.
    await pressKeysLater("Meta+w");
    expect(await promptText()).toBe("Le code de liens.mjs n'est pas enregistré. Fermer quand même ? Il sera perdu.");
    await m.command("WebDriver:DismissAlert");
    expect(await tabs()).toBe(1);
    expect(await value("editeur-code")).toBe("export default async (page) => page.liens; ");
    expect(await count("code-non-enregistre")).toBe(1);

    await pressKeysLater("Meta+w");
    expect(await promptText()).toContain("liens.mjs");
    await m.command("WebDriver:AcceptAlert");
    await poll(tabs, 0);
    expect(await readFile(code, "utf8")).toBe("export default async (page) => page.liens;");
  });

  it("a widget removed while its builder is open is forgotten", async () => {
    await builder("gone");
    await click(m, '[data-testid="palette-liste.garder"]');
    await waitCount("noeud-liste-garder", 1);
    await waitContains("etat-enregistrement", "entrée manquante");

    // Removed from the home page, its builder tab still open behind.
    await home();
    await click(m, '[data-testid="widget-gone"] button[aria-label="Options du widget"]');
    await click(m, '[data-testid="widget-gone"] [role="menuitem"]', { text: "Retirer" });
    await click(m, '[data-testid="confirmation-retrait"] button', { text: "Retirer" });
    await waitUi(m, `return !doc.querySelector('[data-testid="widget-gone"]')`);
    // The home page hides it at once; the host moves its folder to the trash, then says the home page changed.
    await waitUi(m, `return !(await ui.webaios.accueil.lire()).widgets.some((w) => w.id === "gone")`);
    await sleep(300);
    expect(Object.values((await state(m)).onglets).some((o) => o.url === "webaios://workflow/gone")).toBe(true);

    // The agent writes a new widget under the same id, with another workflow.
    await writeWidget(dataDir, "gone", {
      nom: "Veille",
      recolte: { minutes: 60 },
      declaration: { config: { url: `${site.url}/liens` } },
      workflow: {
        version: 1,
        blocs: [
          { id: "page", type: "source.page", parametres: { url: "{config.url}" } },
          { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
        ],
        liens: [{ de: "page", vers: "sortie" }],
      },
    });
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-gone"]')`, [], 15_000);
    await openBuilder(m, "gone");
    await waitUi(m, `const n = [...doc.querySelectorAll(".svelte-flow__node")]; return n.length === 2 && n.every((x) => x.getBoundingClientRect().width > 0)`);
    expect((await nodes(m)).sort()).toEqual(["page", "sortie"]);
    await saved();
  });
});
