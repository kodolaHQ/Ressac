import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NO_WORKFLOW_OPEN } from "../../../packages/noyau/src/index";
import { inWindow, newWindow, waitFor, waitReady, waitWindowCount } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { appelerOutil } from "../test/mcp";
import { click, inUi, missingApi, pressKeys, typeText, waitUi } from "./ui";
import { openBuilder, widgetDir, writeWidget } from "./workflows";

// The workflow builder's Agent tab and `workflow_ouvert`. The
// Agent tab opens the window's agent panel instead of hosting its terminal: a check of the terminal in the tab becomes
// « the panel is open, with one conversation » (one terminal, in the agent frame).

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

let dataDir: string;
let w: LaunchedWebAiOs | undefined;
let m: Marionette;

afterEach(async () => {
  if (w) expect(await missingApi(m)).toEqual([]);
  await w?.close();
  w = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

/** Launches on a data folder with the widgets « veille » and « autre » (WORKFLOW_VEILLE) and « casse » (unreadable). */
async function launch(): Promise<void> {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-builder-agent-"));
  const fichiers = {
    "liens.mjs": "export default async (page) => page.liens;",
    "textes.mjs": "export default async (liens) => ({ liens: liens.map((l) => l.texte) });",
  };
  for (const id of ["veille", "autre"])
    await writeWidget(dataDir, id, { nom: id === "veille" ? "Veille" : "Autre", recolte: { minutes: 60 }, declaration: { config: { url: "https://exemple.invalid/liens" } }, workflow: WORKFLOW_VEILLE, fichiers });
  await writeWidget(dataDir, "casse", { nom: "Cassé", recolte: { minutes: 60 }, workflow: '{ "version": 1, "blocs": [ { "id": "page", "type": "source.pa' });
  w = await launchWebAiOs({ dataDir, height: 1400 });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agentInput = () => read(path.join(dataDir, "espace", "faux-agent-entree.txt"));
/** The terminal's text (xterm's DOM renderer, in the agent frame), spaces normalised. */
const TERMINAL = "(doc.querySelector('.xterm-rows')?.textContent ?? '').replace(/\\u00a0/g, ' ')";
const terminalShows = (text: string) => waitUi(m, `return ${TERMINAL}.includes(arguments[0])`, [text], 20_000, "agent");
const occurrences = (text: string) => inUi<number>(m, `return ${TERMINAL}.split(arguments[0]).length - 1`, [text], "agent");
/** One terminal in the window: in the agent frame, none in the sidebar (the builder hosts none). */
async function oneTerminal(): Promise<void> {
  expect(await inUi(m, "return doc.querySelectorAll('.xterm').length", [], "agent")).toBe(1);
  expect(await inUi(m, "return doc.querySelectorAll('.xterm').length")).toBe(0);
}
const panelShown = () => m.execute<boolean>("return !document.getElementById('webaios-agent').hidden");
const shown = () => waitFor(m, "return !document.getElementById('webaios-agent').hidden", (v) => v === true);
const hidden = () => waitFor(m, "return document.getElementById('webaios-agent').hidden", (v) => v === true);
/** The keyboard is in the terminal: the agent frame has the focus and, in it, xterm's textarea. */
const terminalFocused = async () =>
  (await m.execute("return document.activeElement?.id")) === "webaios-agent" &&
  (await inUi<boolean>(m, "return !!doc.activeElement?.classList.contains('xterm-helper-textarea')", [], "agent"));
const agentTabSelected = () => inUi<string | null>(m, "return doc.querySelector('[data-testid=\"onglet-agent\"]')?.getAttribute('aria-selected') ?? null");
const waitAgentTab = () => waitUi(m, "return doc.querySelector('[data-testid=\"onglet-agent\"]')?.getAttribute('aria-selected') === 'true'");
const blocTab = () => click(m, '.onglets-droite [role="tab"]', { text: "Bloc" });
const count = (testid: string) => inUi<number>(m, `return doc.querySelectorAll('[data-testid="${testid}"]').length`);
const waitCount = (testid: string, n: number) => waitUi(m, `return doc.querySelectorAll('[data-testid="${testid}"]').length === arguments[0]`, [n]);
async function typeInTerminal(text: string): Promise<void> {
  await click(m, ".xterm-screen", { frame: "agent" });
  await typeText(m, text);
  await pressKeys(m, "Enter");
}
/** The home page's panel shows the agent ready. */
async function homeAgent(): Promise<void> {
  await shown();
  await terminalShows("faux agent prêt>");
}
const newTab = () => click(m, '[data-testid="nouvel-onglet"]');

/** The builder of `id`, once its canvas has stopped moving (fitted to its blocks). */
async function builder(id: string): Promise<void> {
  await openBuilder(m, id);
  await waitUi(
    m,
    `const now = JSON.stringify([...doc.querySelectorAll(".svelte-flow__node")].map((n) => n.getBoundingClientRect()));
     await new Promise((r) => setTimeout(r, 150));
     return now === JSON.stringify([...doc.querySelectorAll(".svelte-flow__node")].map((n) => n.getBoundingClientRect()));`,
  );
}

/** The agent session's own MCP config of the window whose agent started last (the fake agent logs its args). */
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const lastSessionConfig = () =>
  path.join(dataDir, "espace", (JSON.parse(read(path.join(dataDir, "espace", "faux-agent-args.json"))) as string[]).at(-1)!.replace(/^\/workspace\//, ""));
const workflowOpen = async (config: string) => (await appelerOutil(path.join(dataDir, "espace"), "workflow_ouvert", {}, config)).texte;
async function poll(read: () => Promise<string>, expected: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v === expected) return;
    if (Date.now() > deadline) return void expect(v).toBe(expected);
    await sleep(100);
  }
}

describe("the builder's Agent tab", () => {
  it("the Agent tab shows the same conversation as the panel, without output duplicates", async () => {
    await launch();
    await homeAgent();
    await typeInTerminal("premier");
    await terminalShows("reçu: premier");

    // In the builder, the panel the home page opened closes; its Agent tab opens it again, with the same conversation.
    await builder("veille");
    await hidden();
    await click(m, '[data-testid="palette-liste.garder"]');
    await waitCount("noeud-liste-garder", 1);
    await click(m, '[data-testid="onglet-agent"]');
    await shown();
    await terminalShows("reçu: premier");
    expect(await occurrences("reçu: premier")).toBe(1);
    await oneTerminal();
    await typeInTerminal("second");
    await terminalShows("reçu: second");
    expect(await occurrences("reçu: second")).toBe(1);
    // ⌘Z typed in the terminal does not undo the canvas's addition.
    await pressKeys(m, "Meta+z");
    await sleep(300);
    expect(await count("noeud-liste-garder")).toBe(1);
    // One session for the window: the input reached the agent once.
    expect(agentInput().split("second\r").length - 1).toBe(1);

    // Back on the home page, the panel keeps the conversation.
    await newTab();
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"page-vide\"]')");
    await shown();
    await terminalShows("reçu: second");
    expect(await occurrences("reçu: second")).toBe(1);
    await oneTerminal();
  });

  it("⌘J and ✦ in the builder open the Agent tab and the agent panel, without pre-filled context", async () => {
    await launch();
    await homeAgent();
    await builder("veille");
    await hidden();
    expect(await agentTabSelected()).toBe("false");
    await pressKeys(m, "Meta+j");
    await waitAgentTab();
    await shown();
    await terminalShows("faux agent prêt>");
    // Back to the Bloc tab, then ✦: the Agent tab again, the panel still open.
    await blocTab();
    expect(await agentTabSelected()).toBe("false");
    await click(m, '[data-testid="bouton-agent"]');
    await waitAgentTab();
    expect(await panelShown()).toBe(true);
    await sleep(500);
    expect(agentInput()).toBe("");
    await oneTerminal();
  });

  it("unreadable workflow.json: no canvas, but ⌘J still opens the Agent tab", async () => {
    await launch();
    await homeAgent();
    await openBuilder(m, "casse");
    await waitCount("workflow-illisible", 1);
    await hidden();
    await pressKeys(m, "Meta+j");
    await waitAgentTab();
    await shown();
    await terminalShows("faux agent prêt>");
  });

  it("entering the builder then leaving it does not give the keyboard to the agent's terminal; ✦ gives it", async () => {
    await launch();
    await homeAgent();
    await builder("veille");
    await sleep(300);
    expect(await terminalFocused()).toBe(false);
    // Back on the home page, which opens the panel again: it shows without taking the keyboard.
    await newTab();
    await shown();
    await sleep(300);
    expect(await terminalFocused()).toBe(false);
    // Opened by the user (✦): then the terminal takes the keyboard.
    await click(m, '[data-testid="bouton-agent"]');
    await hidden();
    await click(m, '[data-testid="bouton-agent"]');
    await shown();
    for (const end = Date.now() + 10_000; !(await terminalFocused()); await sleep(100)) if (Date.now() > end) throw new Error("the terminal did not take the keyboard");
  });

  it("panel closed: Agent → Bloc → Agent keeps a single conversation and a single terminal", async () => {
    await launch();
    await homeAgent();
    // The panel closed by the user on the home page.
    await click(m, '[data-testid="bouton-agent"]');
    await hidden();
    await builder("veille");
    await click(m, '[data-testid="onglet-agent"]');
    await shown();
    await typeInTerminal("un");
    await terminalShows("reçu: un");
    await blocTab();
    expect(await agentTabSelected()).toBe("false");
    await click(m, '[data-testid="onglet-agent"]');
    await waitAgentTab();
    await typeInTerminal("deux");
    await terminalShows("reçu: deux");
    expect(await occurrences("reçu: un")).toBe(1);
    expect(await occurrences("reçu: deux")).toBe(1);
    expect(agentInput()).toBe("un\rdeux\r");
    await oneTerminal();
  });

  it("history laid over the builder: ⌘J closes it and opens the Agent tab", async () => {
    await launch();
    await homeAgent();
    await builder("veille");
    await pressKeys(m, "Meta+y");
    await waitCount("historique", 1);
    expect(await count("constructeur")).toBe(0);
    await pressKeys(m, "Meta+j");
    await waitCount("historique", 0);
    await waitAgentTab();
    await shown();
    await terminalShows("faux agent prêt>");
  });

  it("the agent rewrites workflow.json: the canvas shows the new block without changing the zoom; with an invalid draft, the banner offers both versions", async () => {
    await launch();
    await builder("veille");
    await waitCount("noeud-tri", 1);
    // The user zooms: the view is no longer the opening one.
    const view = () => inUi<string>(m, "return doc.querySelector('.svelte-flow__viewport').getAttribute('style')");
    const before = await view();
    await click(m, ".svelte-flow__controls-zoomin");
    for (const end = Date.now() + 10_000; (await view()) === before; await sleep(100)) if (Date.now() > end) throw new Error("no zoom");
    await sleep(300);
    const zoomed = await view();

    // The agent adds a block between « tri » and « textes » (atomic write, like its tools).
    const file = path.join(widgetDir(dataDir, "veille"), "workflow.json");
    const writeAsAgent = async (workflow: unknown) => {
      await writeFile(`${file}.agent`, JSON.stringify(workflow, null, 2));
      await rename(`${file}.agent`, file);
    };
    await writeAsAgent({
      ...WORKFLOW_VEILLE,
      blocs: [...WORKFLOW_VEILLE.blocs.slice(0, 3), { id: "garder", type: "liste.garder", parametres: { nombre: 5 } }, ...WORKFLOW_VEILLE.blocs.slice(3)],
      liens: [
        { de: "page", vers: "liens" },
        { de: "liens", vers: "tri" },
        { de: "tri", vers: "garder" },
        { de: "garder", vers: "textes" },
        { de: "textes", vers: "sortie" },
      ],
    });
    await waitCount("noeud-garder", 1);
    expect(await count("bandeau-fichier")).toBe(0);
    await sleep(300);
    expect(await view()).toBe(zoomed);

    // An invalid draft, then a new version from the agent: the banner offers both.
    await click(m, '[data-testid="palette-liste.dedoublonner"]');
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"etat-enregistrement\"]')?.textContent.includes('entrée manquante')");
    await writeAsAgent({ ...WORKFLOW_VEILLE, blocs: WORKFLOW_VEILLE.blocs.map((b) => (b.id === "tri" ? { ...b, parametres: { ...b.parametres, seuil: 0.8 } } : b)) });
    await waitCount("bandeau-fichier", 1);
    const visible = (testid: string) => inUi<boolean>(m, `const r = doc.querySelector('[data-testid="${testid}"]')?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0`);
    expect(await visible("bandeau-fichier")).toBe(true);
    expect(await visible("prendre-version")).toBe(true);
    expect(await visible("garder-mienne")).toBe(true);
    expect(await view()).toBe(zoomed);
  });
});

describe("workflow_ouvert", () => {
  it("workflow_ouvert (appelerOutil with the token of this window's session) returns the widget and the selected block", async () => {
    await launch();
    await homeAgent();
    let session = lastSessionConfig();
    const open = () => workflowOpen(session);
    await poll(open, NO_WORKFLOW_OPEN);

    await builder("veille");
    await poll(open, '{"widget":"veille","bloc":null}');
    await click(m, '[data-testid="noeud-tri"]');
    await poll(open, '{"widget":"veille","bloc":"tri"}');
    // The Agent tab changes nothing the agent knows.
    await click(m, '[data-testid="onglet-agent"]');
    await shown();
    await poll(open, '{"widget":"veille","bloc":"tri"}');
    // The host restarts (the panel's Réessayer): the window's new session still sees the selected block.
    await m.execute(`return (async () => { await (await ChromeUtils.importESModule("${STORE}").ready).agent.stop(); })();`);
    await click(m, "button", { text: "Réessayer", frame: "agent" });
    await waitFor(m, "return 1", () => lastSessionConfig() !== session, 20_000);
    session = lastSessionConfig();
    await poll(open, '{"widget":"veille","bloc":"tri"}');
    // The main token (no window) sees no builder.
    expect((await callTool(dataDir, "workflow_ouvert")).texte).toBe(NO_WORKFLOW_OPEN);
    // Builder left: nothing open.
    await newTab();
    await poll(open, NO_WORKFLOW_OPEN);
  });

  it("workflow_ouvert per window: each window's session gets its own widget and block; a closed window's session is gone", async () => {
    await launch();
    await homeAgent();
    const a = lastSessionConfig();
    await builder("veille");
    await click(m, '[data-testid="noeud-tri"]');

    const second = await newWindow(m);
    const b = await inWindow(m, second, async () => {
      await homeAgent();
      await waitFor(m, "return 1", () => lastSessionConfig() !== a);
      const config = lastSessionConfig();
      await builder("autre");
      await click(m, '[data-testid="noeud-liens"]');
      return config;
    });
    await poll(() => workflowOpen(a), '{"widget":"veille","bloc":"tri"}');
    await poll(() => workflowOpen(b), '{"widget":"autre","bloc":"liens"}');

    // Closing the second window ends its session: its config goes and its token is refused; the first window keeps its own.
    const kept = path.join(dataDir, "session-b.json");
    copyFileSync(b, kept);
    await inWindow(m, second, () => m.execute("window.close()"));
    await waitWindowCount(m, 1);
    for (const end = Date.now() + 10_000; existsSync(b); await sleep(100)) if (Date.now() > end) throw new Error("the closed window's session config stays");
    await expect(workflowOpen(kept)).rejects.toThrow();
    expect(await workflowOpen(a)).toBe('{"widget":"veille","bloc":"tri"}');
  });
});
