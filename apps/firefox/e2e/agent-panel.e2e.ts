import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { click, inUi, pressKeys, typeText, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs | undefined;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
afterEach(() => w?.close());

async function launch(env?: Record<string, string>): Promise<void> {
  w = await launchWebAiOs({ env });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
/** The terminal's text (xterm's DOM renderer), spaces normalised. */
const TERMINAL = "return (doc.querySelector('.xterm-rows')?.textContent ?? '').replace(/\\u00a0/g, ' ')";
const terminalShows = (text: string, ms = 20_000) => waitUi(m, `${TERMINAL}.includes(arguments[0])`, [text], ms, "agent");
const terminalText = () => inUi<string>(m, TERMINAL, [], "agent");
const toggleWithButton = () => click(m, '[data-testid="bouton-agent"]');
const shown = () => waitFor(m, "return !document.getElementById('webaios-agent').hidden", (v) => v === true);
const hidden = () => waitFor(m, "return document.getElementById('webaios-agent').hidden", (v) => v === true);
/** Opens a tab and waits for its page; the panel the home page opened closes. */
async function openTab(path: string): Promise<void> {
  await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url: `${server.url}${path}` });
  await waitFor(
    m,
    `return gBrowser.selectedBrowser.currentURI.spec.endsWith(${JSON.stringify(path)}) && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`,
    (v) => v === true,
  );
  await hidden();
}
/** The home page's panel: its agent ready, the terminal clicked to type in it. */
async function homeAgent(): Promise<void> {
  await shown();
  await terminalShows("faux agent prêt>");
  await click(m, ".xterm-screen", { frame: "agent" });
}
async function send(text: string): Promise<void> {
  await typeText(m, text);
  await pressKeys(m, "Enter");
}

it("the home page opens the panel, which runs the fake agent", async () => {
  await launch();
  await shown();
  await terminalShows("faux agent prêt>");
  expect(await inUi(m, "return [...(ui.webaiosMissingApi ?? [])]", [], "agent")).toEqual([]);
});

it("the ✦ button opens and closes the panel", async () => {
  await launch();
  await openTab("/a.html");
  await toggleWithButton();
  await shown();
  await waitUi(m, "return doc.activeElement?.classList.contains('xterm-helper-textarea')", [], 10_000, "agent");
  await toggleWithButton();
  await hidden();
});

it("typing reaches the agent", async () => {
  await launch();
  await homeAgent();
  await send("bonjour");
  await terminalShows("reçu: bonjour");
});

it("agent quits → Relancer starts a new one", async () => {
  await launch();
  await homeAgent();
  const pidFile = join(w!.dataDir, "espace", "faux-agent-pid");
  const first = read(pidFile);
  await send("quitter");
  await waitUi(m, "return doc.querySelector('[data-testid=\"panneau-agent\"]').textContent.includes(\"L'agent s'est arrêté.\")", [], 10_000, "agent");
  await click(m, "button", { text: "Relancer", frame: "agent" });
  await waitFor(m, "return 1", () => read(pidFile) !== "" && read(pidFile) !== first, 20_000);
  await waitUi(m, "return !doc.querySelector('[data-testid=\"panneau-agent\"]').textContent.includes(\"L'agent s'est arrêté.\")", [], 10_000, "agent");
});

it("closing and reopening the panel keeps the conversation", async () => {
  await launch();
  await homeAgent();
  await send("souvenir");
  await terminalShows("reçu: souvenir");
  await toggleWithButton();
  await hidden();
  await toggleWithButton();
  await shown();
  expect(await terminalText()).toContain("reçu: souvenir");
});

it("Docker absent → message and Réessayer", async () => {
  await launch({ FAUX_DOCKER_ABSENT: "1" });
  await shown();
  await waitUi(
    m,
    "return doc.querySelector('[data-testid=\"panneau-agent\"]').textContent.includes(\"Docker n'est pas lancé. La navigation fonctionne ; seul l'agent est indisponible.\")",
    [],
    20_000,
    "agent",
  );
  await waitUi(m, "return [...doc.querySelectorAll('button')].some((b) => b.textContent === 'Réessayer')", [], 10_000, "agent");
});

it("⌘J opens the panel and focuses the terminal", async () => {
  await launch();
  await terminalShows("faux agent prêt>");
  await openTab("/a.html");
  await m.execute("gBrowser.selectedBrowser.focus()");
  await pressKeys(m, "Meta+j");
  await shown();
  await waitFor(m, "return document.activeElement?.id", (v) => v === "webaios-agent");
  await waitUi(m, "return doc.activeElement?.classList.contains('xterm-helper-textarea')", [], 10_000, "agent");
  // Keys typed next go to the agent, after the context prefix opening the panel wrote.
  await send("clavier");
  const input = join(w!.dataDir, "espace", "faux-agent-entree.txt");
  await waitFor(m, "return 1", () => read(input).includes(`[contexte : Page A — ${server.url}/a.html] clavier\r`));
  await pressKeys(m, "Meta+j");
  await hidden();
});

it("the page narrows by the panel width", async () => {
  await launch();
  await openTab("/a.html");
  const width = await m.execute<number>("return window.innerWidth");
  expect(await m.execute("return gBrowser.selectedBrowser.getBoundingClientRect().right")).toBe(width);
  await toggleWithButton();
  await waitFor(m, "return gBrowser.selectedBrowser.getBoundingClientRect().right", (v) => v === width - 420);
  expect(await m.execute("return document.getElementById('webaios-agent').getBoundingClientRect().left")).toBe(width - 420);
});

it("opening the panel on a tab shares it: page_courante reads without asking", async () => {
  await launch();
  // The session started on the home page: a new one would take the access back.
  await terminalShows("faux agent prêt>");
  await openTab("/texte.html");
  await toggleWithButton();
  await shown();
  expect((await callTool(w!.dataDir, "page_courante")).texte).toContain("Le chat dort");
});
