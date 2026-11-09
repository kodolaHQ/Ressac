import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, waitUi } from "./ui";
import { openBuilder, readWorkflow, widgetDir, writeWidget } from "./workflows";

// The workflow builder's runs, replays, implicit workflows, a 30-block workflow and web widgets,
// plus a host restart under an open builder.

/** A workflow shipped by the agent, without positions: a page, its links taken by code, sorted by Kev, then their texts. */
const WORKFLOW_VEILLE = {
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
const LIENS = "export default async (page) => page.liens;";
const TEXTES = "export default async (liens) => ({ liens: liens.map((l) => l.texte) });";
/** The last code block waits a little: time to see the « en cours » badges and the greyed buttons. */
const TEXTES_LENT = "export default async (liens) => { await new Promise((r) => setTimeout(r, 2500)); return { liens: liens.map((l) => l.texte) }; };";

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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
/** The site's log: pages served, by query (each widget reads `/liens?<its id>`). */
const reads = new Map<string, number>();

/** The widget's data folder, outside the space (state, executions, memory). */
const dataOf = (id: string) => path.join(dataDir, "widgets", id);
const executionsOf = (id: string) => path.join(dataOf(id), "executions");
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

/** A widget on WORKFLOW_VEILLE reading `/liens?<id>`; `slow`: its last code block waits 2.5 s. */
const writeVeille = (id: string, o: { slow?: boolean; declaration?: Record<string, unknown> } = {}) =>
  writeWidget(dataDir, id, {
    nom: "Veille",
    recolte: { minutes: 60 },
    declaration: { config: { url: `${site.url}/liens?${id}` }, ...o.declaration },
    workflow: WORKFLOW_VEILLE,
    fichiers: { "liens.mjs": LIENS, "textes.mjs": o.slow ? TEXTES_LENT : TEXTES, "exemple.json": JSON.stringify({ exemple: "veille" }) },
  });
/** No state: harvested at launch (scheduled). */
const dropState = (id: string) => rm(dataOf(id), { recursive: true });
const writeState = async (id: string, etat: Record<string, unknown>) => {
  await mkdir(dataOf(id), { recursive: true });
  await writeFile(path.join(dataOf(id), "etat.json"), JSON.stringify(etat));
};

/** A run's trace of one block. */
const trace = (bloc: string, type: string, debut: string, fields: Record<string, unknown>) => ({
  id: bloc,
  type,
  statut: "reussi",
  debut,
  fin: debut,
  elements: null,
  journal: [],
  ...fields,
});
async function writeExecution(owner: string, id: string, blocs: unknown[]): Promise<void> {
  const debut = id.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "T$1:$2:$3.$4Z");
  await mkdir(executionsOf(owner), { recursive: true });
  await writeFile(
    path.join(executionsOf(owner), `${id}.json`),
    JSON.stringify({ version: 1, id, proprietaire: { type: "widget", id: owner }, declencheur: "planifiee", debut, fin: debut, statut: "reussie", blocs }),
  );
}

/** 30 blocks: six code sources, each followed by three lists, merged, then sorted and shaped. */
function thirtyBlocks(): { workflow: { version: number; blocs: unknown[]; liens: unknown[] }; fichiers: Record<string, string> } {
  const blocs: { id: string; type: string; parametres: Record<string, unknown> }[] = [];
  const liens: { de: string; vers: string }[] = [];
  const fichiers: Record<string, string> = {};
  for (let i = 1; i <= 6; i++) {
    blocs.push({ id: `source-${i}`, type: "code", parametres: { source: `source-${i}.mjs` } });
    fichiers[`source-${i}.mjs`] = `export default async () => [{ url: "https://exemple.invalid/${i}" }];`;
    blocs.push({ id: `nouveaux-${i}`, type: "liste.nouveaux", parametres: { cle: "url" } });
    blocs.push({ id: `dedoublonner-${i}`, type: "liste.dedoublonner", parametres: { cles: ["url"] } });
    blocs.push({ id: `garder-${i}`, type: "liste.garder", parametres: { nombre: 10 } });
    liens.push({ de: `source-${i}`, vers: `nouveaux-${i}` }, { de: `nouveaux-${i}`, vers: `dedoublonner-${i}` }, { de: `dedoublonner-${i}`, vers: `garder-${i}` });
    liens.push({ de: `garder-${i}`, vers: "fusion" });
  }
  blocs.push(
    { id: "fusion", type: "code", parametres: { source: "fusion.mjs" } },
    { id: "tri", type: "ia.trier", parametres: { question: "Parle d'IA ?", texte: "{url}", seuil: 0.5 } },
    { id: "garder", type: "liste.garder", parametres: { nombre: 20 } },
    { id: "dedoublonner", type: "liste.dedoublonner", parametres: { cles: ["url"] } },
    { id: "forme", type: "code", parametres: { source: "forme.mjs" } },
    { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
  );
  fichiers["fusion.mjs"] = "export default async (entrees) => Object.values(entrees).flat();";
  fichiers["forme.mjs"] = "export default async (liens) => ({ liens });";
  liens.push({ de: "fusion", vers: "tri" }, { de: "tri", vers: "garder" }, { de: "garder", vers: "dedoublonner" }, { de: "dedoublonner", vers: "forme" }, { de: "forme", vers: "sortie" });
  return { workflow: { version: 1, blocs, liens }, fichiers };
}

const TRUNCATED = "2026-10-29T10-00-00-000Z";
const GMAIL_RUNS = ["2026-10-28T08-00-00-000Z", "2026-10-28T09-00-00-000Z"];
const SIMPLE_CODE = "export default async () => ({ bon: true });";
/** A state « up to date » whose hours tracking says all done: no hour is due during the test. */
const noHourDue = () => {
  const now = new Date().toISOString();
  return { statut: "ok", derniereMaj: now, derniereTentative: now, heures: { faite: "9999-12-31T23:59", echecs: null } };
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

  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-builder-runs-"));
  await writeVeille("lancer", { slow: true });
  await writeVeille("rejouer");
  await dropState("rejouer");
  await writeVeille("tronque");
  const debut = "2026-10-29T10:00:00.000Z";
  await writeExecution("tronque", TRUNCATED, [
    trace("page", "source.page", debut, { sortie: { titre: "Liens" } }),
    trace("liens", "code", debut, { elements: 2, sortie: '[{"texte":"Nouveau', sortieTronquee: true }),
    trace("tri", "ia.trier", debut, { elements: 1, sortie: [] }),
    trace("textes", "code", debut, { sortie: { liens: [] } }),
    trace("sortie", "sortie", debut, { sortie: { liens: [] } }),
  ]);
  await writeVeille("grise", { slow: true });
  await dropState("grise");
  // Like a Gmail widget: widget.json, recolte.mjs, affichage.html, an account, no workflow.json.
  await writeWidget(dataDir, "gmail", {
    nom: "Gmail",
    recolte: { minutes: 60 },
    declaration: { sources: { compte: ["127.0.0.1"], publiques: [] }, config: { url: `${site.url}/boite` } },
    fichiers: {
      "recolte.mjs": "export default async (webaios) => ({ vu: (await webaios.lirePage(webaios.config.url, { compte: true })).titre });",
      "exemple.json": JSON.stringify({ exemple: "gmail" }),
    },
  });
  // The accord is missing and was just asked: no run starts at launch.
  const now = new Date().toISOString();
  await writeState("gmail", {
    statut: "accord-requis",
    derniereMaj: now,
    derniereTentative: now,
    erreur: "Accord requis pour lire avec ton compte : 127.0.0.1",
    erreurNoyau: true,
  });
  // Two past runs, to choose another than the last.
  for (const id of GMAIL_RUNS) {
    const d = id.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "T$1:$2:$3.$4Z");
    await writeExecution("gmail", id, [trace("recolte", "code", d, { sortie: { vu: id } }), trace("sortie", "sortie", d, { sortie: { vu: id } })]);
  }
  await writeWidget(dataDir, "simple", {
    nom: "Simple",
    recolte: { minutes: 60 },
    fichiers: { "recolte.mjs": SIMPLE_CODE, "exemple.json": JSON.stringify({ exemple: "simple" }) },
  });
  await dropState("simple");
  await writeVeille("coupe");
  const big = thirtyBlocks();
  await writeWidget(dataDir, "grand", { nom: "Grand", recolte: { minutes: 60 }, workflow: big.workflow, fichiers: big.fichiers });
  await writeWidget(dataDir, "web", {
    nom: "Veille",
    recolte: { heures: ["07:00", "19:00"], dureeMaxMinutes: 30, notifier: true },
    declaration: { sources: { compte: [], publiques: [], web: true }, config: { url: `${site.url}/liens?web` } },
    workflow: WORKFLOW_VEILLE,
    fichiers: { "liens.mjs": LIENS, "textes.mjs": TEXTES },
  });
  await writeState("web", noHourDue());
  await writeVeille("sansweb");
  await writeWidget(dataDir, "fil", {
    nom: "Veille",
    recolte: { minutes: 60 },
    declaration: { config: { url: `${site.url}/liens?fil` } },
    workflow: {
      version: 1,
      blocs: [
        { id: "page", type: "source.page", parametres: { url: "{config.url}" } },
        { id: "liens", type: "code", parametres: { source: "liens.mjs" } },
        { id: "garder", type: "liste.garder", parametres: { nombre: 5 } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget", auFilDeLEau: true } },
      ],
      liens: [
        { de: "page", vers: "liens" },
        { de: "liens", vers: "garder" },
        { de: "garder", vers: "sortie" },
      ],
    },
    fichiers: { "liens.mjs": LIENS },
  });
  await writeVeille("relance", { slow: true });

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
  for (const o of Object.values((await state(m)).onglets)) if (o.url.startsWith("webaios://workflow/")) await dispatch(m, { type: "fermerOnglet", id: o.id });
});

/** Back to the home page of the window. */
async function home(): Promise<void> {
  await dispatch(m, { type: "afficherPageVide", fenetreId: (await state(m)).fenetres[0]!.id });
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
const saved = () => waitText(tid("etat-enregistrement"), "Enregistré");
const textOf = (css: string) => inUi<string | null>(m, `return ${el(css)}?.textContent ?? null`);
/** The text of the `#donnees` of an iframe in `css` (a home widget's or the preview's display). */
const shown = (css: string) => inUi<string>(m, `return ${el(`${css} iframe`)}?.contentDocument?.getElementById("donnees")?.textContent ?? ""`);
const preview = () => shown(tid("apercu-widget"));
const homeData = (id: string) => shown(tid(`widget-${id}`));
const harvest = (id: string) => inUi(m, "ui.webaios.accueil.recolter(arguments[0])", [id]);
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
    `ui.webaiosErrors = [];
     if (ui.webaiosErrorsTracked) return;
     ui.webaiosErrorsTracked = true;
     const error = ui.console.error.bind(ui.console);
     ui.console.error = (...a) => (ui.webaiosErrors.push(a.map(String).join(" ")), error(...a));
     ui.addEventListener("error", (e) => ui.webaiosErrors.push(e.message));
     ui.addEventListener("unhandledrejection", (e) => ui.webaiosErrors.push(String(e.reason)));`,
  );
const errors = () => inUi<string[]>(m, "return [...ui.webaiosErrors]");

/** The agent rewrites workflow.json (atomic write, like its tools). */
async function writeAsAgent(id: string, workflow: unknown): Promise<void> {
  const file = path.join(widgetDir(dataDir, id), "workflow.json");
  await writeFile(`${file}.agent`, JSON.stringify(workflow, null, 2));
  await rename(`${file}.agent`, file);
}
const thresholdOf = async (id: string) => (await readWorkflow(dataDir, id)).blocs.find((b: { id: string }) => b.id === "tri").parametres.seuil;
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const agent = (body: string) => m.execute(`return (async () => { const agent = (await ChromeUtils.importESModule("${STORE}").ready).agent; ${body} })();`);

describe("the workflow builder's runs", () => {
  it("▶ Lancer : pastilles en cours puis éléments par bloc, nouvelle exécution choisie, aperçu à jour", async () => {
    await home();
    await trackErrors();
    await builder("lancer");
    await waitVisible(tid("noeud-textes"));
    // No run: the preview shows the example, as the home page does.
    await click(m, tid("bouton-apercu"));
    await poll(preview, '{"exemple":"veille"}');
    await waitCount(tid("apercu-mention"), 0);

    await click(m, tid("lancer"));
    await waitClass(tid("pastille-textes"), "en-cours", 20_000);
    await waitText(tid("pastille-liens"), "2");
    await waitDisabled(tid("lancer"), true);
    await waitClass(tid("pastille-textes"), "ok", 20_000);
    await waitText(tid("pastille-tri"), "1");
    await waitDisabled(tid("lancer"), false);
    const [id] = (await runs("lancer")).map((f) => f.replace(/\.json$/, ""));
    await waitPressed(tid(`execution-${id}`));
    await waitContains(tid(`execution-${id}`), "Manuelle");
    await waitContains(tid(`execution-${id}`), "Réussie");
    await poll(preview, '{"liens":["Nouveau modèle IA"]}');
    expect(await errors()).toEqual([]);
  });

  it("Rejouer depuis tri après avoir changé le seuil : essai marqué, page non relue, données, mémoire et état inchangés, aperçu de l'essai", async () => {
    await home();
    // Without a state: harvested at launch (a real run, the page read once).
    await poll(() => homeData("rejouer"), '{"liens":["Nouveau modèle IA"]}', 20_000);
    const dir = dataOf("rejouer");
    const [origin] = (await runs("rejouer")).map((f) => f.replace(/\.json$/, ""));
    await builder("rejouer");
    await waitPressed(tid(`execution-${origin}`));
    // Nothing selected: nothing to replay.
    await waitDisabled(tid("rejouer"), true);

    await click(m, tid("noeud-tri"));
    const seuil = `${tid("volet-bloc")} ${tid("champ-seuil")}`;
    await fill(seuil, "0.05");
    await pressEnter();
    await poll(() => thresholdOf("rejouer"), 0.05);
    await saved();
    const before = {
      donnees: await content(path.join(dir, "donnees.json")),
      memoire: await content(path.join(dir, "memoire.json")),
      etat: await content(path.join(dir, "etat.json")),
    };
    expect(before.donnees).not.toBeNull();
    const pages = reads.get("rejouer") ?? 0;
    // The harvest at launch did read the fake site: its log counts.
    expect(pages).toBeGreaterThan(0);

    await click(m, tid("rejouer"));
    await poll(async () => (await runs("rejouer")).length, 2, 20_000);
    const trial = (await runs("rejouer")).find((f) => f.includes("-essai"))!.replace(/\.json$/, "");
    const button = tid(`execution-${trial}`);
    await waitContains(button, "essai");
    await waitPressed(button);
    await waitCount(tid("refus-rejeu"), 0);
    await waitClass(tid("pastille-liens"), "neutre");
    await waitText(tid("pastille-tri"), "2");
    await click(m, tid("bouton-apercu"));
    await poll(preview, '{"liens":["Nouveau modèle IA","Recette de cuisine"]}');
    await waitCount(tid("apercu-mention"), 0);

    // tri's output, opened on the trial, stays open when the trial is read again (the origin, then the trial).
    const output = tid("sortie-bloc");
    await click(m, `${output} ${tid("sortie-repliable")} summary`);
    await waitVisible(`${output} ${tid("sortie-json")}`);
    await click(m, tid(`execution-${origin}`));
    await waitPressed(tid(`execution-${origin}`));
    await waitCount(`${output} ${tid("sortie-json")}`, 0);
    await click(m, button);
    await waitPressed(button);
    await waitVisible(`${output} ${tid("sortie-json")}`);

    // The page was not read again; neither the data, the memory nor the widget's state moved.
    expect(reads.get("rejouer")).toBe(pages);
    expect(await content(path.join(dir, "donnees.json"))).toBe(before.donnees);
    expect(await content(path.join(dir, "memoire.json"))).toBe(before.memoire);
    expect(await content(path.join(dir, "etat.json"))).toBe(before.etat);

    // The « Exécutions » tab: all of them, the trial marked with its starting block; choosing one goes back to the canvas.
    await click(m, tid("vue-executions"));
    const list = tid("liste-executions");
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
    await click(m, tid("noeud-tri"));
    for (const n of [3, 4]) {
      await waitDisabled(tid("rejouer"), false);
      await click(m, tid("rejouer"));
      await poll(async () => (await runs("rejouer")).length, n, 20_000);
      await waitCount(tid("refus-rejeu"), 0);
      const last = (await runs("rejouer")).filter((f) => f.includes("-essai")).at(-1)!.replace(/\.json$/, "");
      await waitPressed(tid(`execution-${last}`));
      await waitText(tid("pastille-tri"), "2");
      expect((await readJson(path.join(executionsOf("rejouer"), `${last}.json`))).essai).toEqual({ depart: "tri", origine: origin });
    }
    expect(reads.get("rejouer")).toBe(pages);
  });

  it("Rejouer depuis un bloc dont la sortie amont est tronquée : message « Rejeu impossible : … tronquée … », aucune exécution ajoutée", async () => {
    await builder("tronque");
    await waitPressed(tid(`execution-${TRUNCATED}`));
    await click(m, tid("noeud-tri"));
    await click(m, tid("rejouer"));
    await waitText(tid("refus-rejeu"), "Rejeu impossible : la sortie de « liens » a été tronquée dans cette exécution");
    await sleep(500);
    expect(await runs("tronque")).toEqual([`${TRUNCATED}.json`]);
    await waitDisabled(tid("rejouer"), false);
  });

  it("pendant une exécution, Lancer et Rejouer sont grisés", async () => {
    await home();
    // Without a state: harvested at launch, it has a run to replay.
    await poll(() => homeData("grise"), '{"liens":["Nouveau modèle IA"]}', 20_000);
    await builder("grise");
    await click(m, tid("noeud-tri"));
    await waitDisabled(tid("rejouer"), false);
    await waitDisabled(tid("lancer"), false);

    // A run started elsewhere (the agent, the home page): the builder sees it live.
    await harvest("grise");
    await waitDisabled(tid("lancer"), true);
    await waitDisabled(tid("rejouer"), true);
    await waitClass(tid("pastille-textes"), "en-cours", 20_000);
    // At the end, the view settles on the run written: no « en cours » badge any more.
    await waitDisabled(tid("lancer"), false, 20_000);
    await waitDisabled(tid("rejouer"), false);
    await waitClass(tid("pastille-textes"), "ok");
    await waitText(tid("pastille-tri"), "1");
  });

  it("un widget avec seulement recolte.mjs et un compte : le constructeur montre recolte → sortie ; ouvrir, sélectionner, réorganiser, choisir une exécution n'écrivent rien", async () => {
    const dir = widgetDir(dataDir, "gmail");
    await home();
    await trackErrors();
    await waitContains(`${tid("widget-gmail")} ${tid("bandeau-accord")}`, "127.0.0.1");
    // The home page settled: what it may have written at launch does not count.
    await sleep(1500);
    const before = { space: await snapshot(dir, true), data: await snapshot(dataOf("gmail"), true) };
    expect(before.data.some((f) => f.startsWith("etat.json:"))).toBe(true);

    await openBuilder(m, "gmail");
    await waitContains(tid("noeud-recolte"), "code");
    await waitContains(tid("noeud-sortie"), "sortie");
    await saved();
    // The last run is chosen on opening.
    await waitPressed(tid(`execution-${GMAIL_RUNS[1]}`));

    // Selecting with a jittered click (under the 4 px drag threshold).
    await drag(tid("noeud-recolte"), 2, 1, 1);
    await waitVisible(tid("volet-bloc"));
    await click(m, tid("noeud-sortie"));
    // Reorganising, then choosing the other run.
    await click(m, tid("reorganiser"));
    await click(m, tid(`execution-${GMAIL_RUNS[0]}`));
    await waitPressed(tid(`execution-${GMAIL_RUNS[0]}`));
    await sleep(1500);

    expect(existsSync(path.join(dir, "workflow.json"))).toBe(false);
    expect(await snapshot(dir, true)).toEqual(before.space);
    expect(await snapshot(dataOf("gmail"), true)).toEqual(before.data);
    expect(await errors()).toEqual([]);
  });

  it("modifier le workflow implicite crée workflow.json, garde recolte.mjs, et le widget se met à jour avec les mêmes données", async () => {
    const dir = widgetDir(dataDir, "simple");
    await home();
    // Without a state: harvested at launch, by recolte.mjs alone.
    await poll(() => homeData("simple"), '{"bon":true}', 20_000);
    expect(await runs("simple")).toHaveLength(1);
    expect(existsSync(path.join(dir, "workflow.json"))).toBe(false);

    await builder("simple");
    // A real gesture: moving the output by 80 px.
    await drag(tid("noeud-sortie"), 80, 40, 10);
    await poll(async () => existsSync(path.join(dir, "workflow.json")), true);
    await saved();
    const written = await readWorkflow(dataDir, "simple");
    expect(written.blocs.map((x: { id: string; type: string }) => `${x.id}:${x.type}`)).toEqual(["recolte:code", "sortie:sortie"]);
    expect(written.blocs[0].parametres).toMatchObject({ source: "recolte.mjs" });
    expect(written.liens).toEqual([{ de: "recolte", vers: "sortie" }]);
    expect(await readFile(path.join(dir, "recolte.mjs"), "utf8")).toBe(SIMPLE_CODE);

    // The widget now goes through workflow.json: same data.
    await click(m, tid("nouvel-onglet"));
    await poll(() => homeData("simple"), '{"bon":true}');
    await harvest("simple");
    await poll(async () => (await runs("simple")).length, 2, 20_000);
    const last = await readJson(path.join(executionsOf("simple"), (await runs("simple")).at(-1)!));
    expect(last.statut).toBe("reussie");
    expect(last.declencheur).toBe("manuelle");
    await poll(() => homeData("simple"), '{"bon":true}');
    expect(await readJson(path.join(dataOf("simple"), "donnees.json"))).toEqual({ bon: true });
    expect((await readJson(path.join(dataOf("simple"), "etat.json"))).statut).toBe("ok");
  });

  it("l'agent écrit un workflow.json coupé : le canevas reste, le bandeau dit « illisible », le widget affiche « Workflow invalide : … »", async () => {
    const file = path.join(widgetDir(dataDir, "coupe"), "workflow.json");
    await builder("coupe");
    await waitVisible(tid("noeud-tri"));

    // The agent writes without a temporary file: JSON cut in the middle.
    const cut = JSON.stringify(WORKFLOW_VEILLE).slice(0, 120);
    await writeFile(file, cut);
    await waitContains(tid("bandeau-fichier"), "illisible");
    for (const id of ["page", "liens", "tri", "textes", "sortie"]) await waitVisible(tid(`noeud-${id}`));
    await waitCount(tid("workflow-illisible"), 0);
    await sleep(500);
    // The builder did not write over it.
    expect(await readFile(file, "utf8")).toBe(cut);

    // On the home page, the next harvest says so on the widget.
    await click(m, tid("nouvel-onglet"));
    await harvest("coupe");
    await waitContains(tid("widget-coupe"), "Workflow invalide : ", 20_000);
    expect((await readJson(path.join(dataOf("coupe"), "etat.json"))).erreur).toMatch(/^Workflow invalide : /);
  });

  it("un workflow de 30 blocs s'ouvre lisible : aucun nœud ne se chevauche, tous dans la vue après fitView", async () => {
    expect(thirtyBlocks().workflow.blocs).toHaveLength(30);
    const before = await snapshot(widgetDir(dataDir, "grand"));
    await builder("grand");
    await saved();
    await waitCount('[data-testid^="noeud-"]', 30);
    await sleep(500);
    const { view, boxes } = await inUi<{ view: Box; boxes: Box[] }>(
      m,
      `const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
       return { view: box(doc.querySelector(".svelte-flow")), boxes: [...doc.querySelectorAll('[data-testid^="noeud-"]')].map(box) };`,
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

  it("le panneau Widget d'un widget web affiche « Accès au web : ouvert » et ses heures ; Chercher sur le web s'ajoute depuis la palette", async () => {
    const declaration = await readFile(path.join(widgetDir(dataDir, "web"), "widget.json"), "utf8");
    await builder("web");
    const panel = tid("panneau-widget");
    await waitText(tid("widget-web"), "Accès au web : ouvert");
    await waitText(tid("widget-heures"), "Heures prévues : 07:00, 19:00");
    await waitContains(panel, "Durée maximale : 30 min");
    await waitContains(panel, "Notification à la fin : oui");

    const search = tid("palette-web.chercher");
    await waitDisabled(search, false);
    await click(m, search);
    await waitVisible(tid("noeud-web-chercher"));
    await waitTrue(`!${el(tid("etat-enregistrement"))}.textContent.includes("doit déclarer")`);
    // widget.json is never written by the builder.
    expect(await readFile(path.join(widgetDir(dataDir, "web"), "widget.json"), "utf8")).toBe(declaration);
  });

  it("dans un widget sans web, Chercher sur le web est grisé ; un web.chercher écrit par l'agent rend « Non enregistré » / « Workflow invalide : web.chercher … »", async () => {
    await builder("sansweb");
    await waitVisible(tid("noeud-tri"));
    // Nothing about the web in the panel of a widget without access.
    await waitCount(tid("widget-web"), 0);
    await waitCount(tid("widget-heures"), 0);
    const search = tid("palette-web.chercher");
    await waitDisabled(search, true);
    expect(await inUi(m, `return ${el(search)}.getAttribute("title")`)).toBe('Le widget doit déclarer "web": true : demande-le à l\'agent.');
    // Playwright's force click: the mouse on a disabled button.
    await click(m, search);
    await sleep(300);
    await waitCount(tid("noeud-web-chercher"), 0);

    await writeAsAgent("sansweb", {
      version: 1,
      blocs: [
        { id: "chercher", type: "web.chercher", parametres: { requete: "voitures" } },
        { id: "sortie", type: "sortie", parametres: { vers: "widget" } },
      ],
      liens: [{ de: "chercher", vers: "sortie" }],
    });
    await waitVisible(tid("noeud-chercher"));
    await waitContains(tid("etat-enregistrement"), "Non enregistré : ");
    await waitContains(tid("etat-enregistrement"), 'Workflow invalide : web.chercher : le widget doit déclarer "web": true');
  });

  it("auFilDeLEau derrière Garder les N premiers : avertissement sur la sortie", async () => {
    await builder("fil");
    await click(m, tid("noeud-sortie"));
    await waitContains(tid("avertissement-sortie"), "rien à publier au fil de l'eau : l'entrée de la sortie n'est pas traitée élément par élément");
    await waitClass(tid("noeud-sortie"), "avertit");
    await saved();

    // Unchecked, the box removes the key (absent = false): nothing else is written in the output.
    const box = tid("champ-auFilDeLEau");
    await waitTrue(`${el(box)}?.checked === true`);
    await click(m, box);
    await poll(async () => (await readWorkflow(dataDir, "fil")).blocs.find((b: { id: string }) => b.id === "sortie").parametres, { vers: "widget" });
    await waitCount(tid("avertissement-sortie"), 0);
  });

  it("the builder keeps working after a host restart", async () => {
    await builder("relance");
    await waitVisible(tid("noeud-textes"));
    // The host stops under the open builder (as accueil.e2e.ts does), then starts again (the agent panel's Réessayer).
    await agent("await agent.stop();");
    await waitFor<number | null>(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`, (pid) => pid === null);
    await agent("await agent.ensure();");

    await waitDisabled(tid("lancer"), false);
    await click(m, tid("lancer"));
    await waitClass(tid("pastille-textes"), "en-cours", 20_000);
    await waitDisabled(tid("lancer"), true);
    await waitClass(tid("pastille-textes"), "ok", 20_000);
    await waitText(tid("pastille-tri"), "1");
    await waitDisabled(tid("lancer"), false);
    const all = await runs("relance");
    expect(all).toHaveLength(1);
    await waitPressed(tid(`execution-${all[0]!.replace(/\.json$/, "")}`));
    expect(await textOf(tid(`execution-${all[0]!.replace(/\.json$/, "")}`))).toContain("Manuelle");
  });
});
