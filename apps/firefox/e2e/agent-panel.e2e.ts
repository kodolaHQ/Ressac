import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, inWindow, newWindow, pressClosing, state, waitFor, waitReady, waitWindowCount } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { click, inUi, pressKeys, typeText, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac | undefined;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
afterEach(() => w?.close());

async function launch(env?: Record<string, string>, dataDir?: string, prefs?: Record<string, number>): Promise<void> {
  w = await launchRessac({ env, dataDir, prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
/** The terminal's text (xterm's DOM renderer), spaces normalised. */
const TERMINAL = "return (doc.querySelector('.xterm-rows')?.textContent ?? '').replace(/\\u00a0/g, ' ')";
const terminalShows = (text: string, ms = 20_000) => waitUi(m, `${TERMINAL}.includes(arguments[0])`, [text], ms, "agent");
const terminalText = () => inUi<string>(m, TERMINAL, [], "agent");
const toggleWithButton = () => click(m, '[data-testid="agent-button"]');
const shown = () => waitFor(m, "return !document.getElementById('ressac-agent').hidden", (v) => v === true);
const hidden = () => waitFor(m, "return document.getElementById('ressac-agent').hidden", (v) => v === true);
/** Opens the window's panel with ✦ (it never opens on its own); its session starts with it. */
async function openPanel(): Promise<void> {
  if (await m.execute("return document.getElementById('ressac-agent').hidden")) await toggleWithButton();
  await shown();
}
/** Opens a tab and waits for its page. */
async function openTab(path: string): Promise<void> {
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${server.url}${path}` });
  await waitFor(
    m,
    `return gBrowser.selectedBrowser.currentURI.spec.endsWith(${JSON.stringify(path)}) && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`,
    (v) => v === true,
  );
}
/** The panel opened: its agent ready, the terminal clicked to type in it. */
async function homeAgent(): Promise<void> {
  await openPanel();
  await terminalShows("fake agent ready>");
  await click(m, ".xterm-screen", { frame: "agent" });
}
async function send(text: string): Promise<void> {
  await typeText(m, text);
  await pressKeys(m, "Enter");
}

it("the panel stays closed on the home page and no session starts; ✦ opens it, which runs the fake agent", async () => {
  await launch();
  await new Promise((r) => setTimeout(r, 1500));
  expect(await m.execute("return document.getElementById('ressac-agent').hidden")).toBe(true);
  expect(existsSync(join(w!.dataDir, "workspace", "fake-agent-pid"))).toBe(false);
  await openPanel();
  await terminalShows("fake agent ready>");
  expect(await inUi(m, "return [...(ui.ressacMissingApi ?? [])]", [], "agent")).toEqual([]);
});

const SESSION_CONFIG = /^\/workspace\/\.ressac\/sessions\/[0-9a-f]{16}\.json$/;
const panelShows = (text: string, ms = 20_000) =>
  waitUi(m, "return doc.querySelector('[data-testid=\"agent-panel\"]').textContent.includes(arguments[0])", [text], ms, "agent");
const retryButton = () => waitUi(m, "return [...doc.querySelectorAll('button')].some((b) => b.textContent === 'Réessayer')", [], 10_000, "agent");

it("without Docker, browsing works", async () => {
  await launch({ FAKE_DOCKER_ABSENT: "1" });
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${server.url}/a.html` });
  await waitFor(m, "return gBrowser.selectedBrowser.contentTitle", (v) => v === "Page A");
});

it("the panel runs the real CLI with the session's MCP config", async () => {
  await launch();
  await openPanel();
  await terminalShows("fake agent ready>");
  expect(JSON.parse(read(join(w!.dataDir, "workspace", "fake-agent-args.json")))).toEqual([
    "claude",
    "--append-system-prompt",
    "Always reply to the user in French, whatever language the instructions are written in.",
    "--disallowedTools",
    "Bash,mcp__ressac__launch_app",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--settings",
    '{"skipDangerousModePermissionPrompt":true}',
    "--append-system-prompt-file",
    "/workspace/.ressac/instructions/AGENTS.md",
    "--disallowedTools",
    "WebSearch,WebFetch",
    "--dangerously-skip-permissions",
    "--mcp-config",
    expect.stringMatching(SESSION_CONFIG),
  ]);
});

it("« Atelier » relaunches the agent with its shell, the choice is saved, another window offers « Relancer »", async () => {
  await launch();
  await openPanel();
  await terminalShows("fake agent ready>");
  const args = () => read(join(w!.dataDir, "workspace", "fake-agent-args.json"));
  const first = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  const second = await newWindow(m);
  await inWindow(m, second, async () => {
    await openPanel();
    await terminalShows("fake agent ready>");
  });
  expect(args()).toContain("Bash");
  await m.command("WebDriver:SwitchToWindow", { handle: first, focus: true });
  await click(m, '[data-testid="agent-mode-workshop"]', { frame: "agent" });
  await waitUi(m, "return doc.querySelector('[data-testid=\"agent-mode-workshop\"]').getAttribute('aria-checked') === 'true'", [], 10_000, "agent");
  // The relaunch resumes the conversation, now with the shell.
  await expect.poll(args, { timeout: 20_000 }).toContain("--continue");
  expect(args()).not.toMatch(/Bash|launch_app|strict-mcp-config/);
  expect((await state(m)).settings.agentMode).toBe("workshop");
  // The other window's agent still runs in browser mode: its panel offers the relaunch.
  await inWindow(m, second, () => waitUi(m, "return !!doc.querySelector('[data-testid=\"agent-engine-changed\"]')", [], 10_000, "agent"));
  await waitUi(m, "return !doc.querySelector('[data-testid=\"agent-engine-changed\"]')", [], 10_000, "agent");
});

it("« Navigateur » relaunches the Atelier session of another window in Navigateur too", async () => {
  await launch();
  await openPanel();
  await terminalShows("fake agent ready>");
  const root = join(w!.dataDir, "workspace");
  /** Every agent session the fake docker started, in order: its id and whether it runs in Navigateur (no shell). */
  const sessions = () =>
    read(join(root, "fake-docker-all.log"))
      .split("\n")
      .filter((l) => l.includes("ressac-session"))
      .map((l) => ({ id: /RESSAC_SESSION=([0-9a-f]+)/.exec(l)?.[1], browser: l.includes("Bash,mcp__ressac__launch_app") }));
  const first = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  await click(m, '[data-testid="agent-mode-workshop"]', { frame: "agent" });
  await expect.poll(() => sessions().at(-1)?.browser, { timeout: 20_000 }).toBe(false);
  const before = sessions().length;
  const second = await newWindow(m);
  await inWindow(m, second, async () => {
    await openPanel();
    await terminalShows("fake agent ready>");
  });
  await expect.poll(() => sessions().length, { timeout: 20_000 }).toBeGreaterThan(before);
  // Its terminal is ready: the last session started is the one it runs.
  const at = sessions().length - 1;
  const other = sessions()[at]!;
  expect(other.browser).toBe(false);
  await m.command("WebDriver:SwitchToWindow", { handle: first, focus: true });
  await click(m, '[data-testid="agent-mode-browser"]', { frame: "agent" });
  // The other window's Atelier session stops, and both windows run a new session in Navigateur.
  await expect.poll(() => read(join(root, "fake-docker-stops.log")), { timeout: 20_000 }).toContain(`RESSAC_SESSION=${other.id}`);
  await expect.poll(() => sessions().slice(at + 1).filter((s) => s.browser).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await inWindow(m, second, async () => {
    await terminalShows("fake agent ready>");
    expect(await inUi(m, "return !!doc.querySelector('[data-testid=\"agent-engine-changed\"]')", [], "agent")).toBe(false);
  });
});

it("a huge output does not freeze the UI", async () => {
  await launch();
  await homeAgent();
  await send("flood");
  // The orb turns while the agent's output flows, and stops once it is quiet.
  const ORB = "return doc.querySelector('[data-testid=\"agent-orb\"]').classList.contains('busy')";
  await waitUi(m, ORB, [], 10_000, "agent");
  // 1 MB later, the command has scrolled off the screen and the prompt is back at the bottom.
  await waitUi(m, `const t = ${TERMINAL.slice("return ".length)}; return !t.includes("received: flood") && t.includes("ready>")`, [], 20_000, "agent");
  expect(read(join(w!.dataDir, "workspace", "fake-agent-input.txt"))).toContain("flood\r");
  await waitUi(m, `return !(${ORB.slice("return ".length)})`, [], 10_000, "agent");
  await click(m, '[data-testid="new-tab"]');
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"empty-page\"]')", [], 10_000);
});

it("a container that cannot start → error and Réessayer", async () => {
  await launch({ FAKE_DOCKER_FAILURE: "1" });
  await openPanel();
  await panelShows("L'agent n'a pas pu démarrer :");
  await panelShows("simulated failure");
  await retryButton();
});

it("a second profile in .ressac/profiles appears in the panel; choosing it restarts the agent with its command", async () => {
  const dataDir = mkdtempSync(join(os.tmpdir(), "ressac-data-"));
  try {
    mkdirSync(join(dataDir, "workspace", ".ressac", "profiles"), { recursive: true });
    writeFileSync(
      join(dataDir, "workspace", ".ressac", "profiles", "autre.json"),
      JSON.stringify({ id: "autre", name: "Autre", interactive: ["autre-agent", "--mcp", "{mcpConfig}"], nonInteractive: ["autre-agent", "-p", "{consigne}"], mcpConfig: "claude-json" }),
    );
    await launch(undefined, dataDir);
    await openPanel();
    await terminalShows("fake agent ready>");
    const pidFile = join(dataDir, "workspace", "fake-agent-pid");
    const first = read(pidFile);
    const select = '[data-testid="agent-profile"]';
    expect(await waitUi(m, "const o = [...(doc.querySelector(arguments[0])?.options ?? [])].map((x) => x.textContent.trim()); return o.length && o", [select], 10_000, "agent")).toEqual([
      "Autre",
      "Claude Code (non connecté)",
      "Codex (non connecté)",
    ]);
    // A custom profile runs only in Atelier mode.
    await click(m, '[data-testid="agent-mode-workshop"]', { frame: "agent" });
    await waitFor(m, "return 1", () => read(pidFile) !== "" && read(pidFile) !== first, 20_000);
    const workshop = read(pidFile);
    await terminalShows("fake agent ready>");
    await inUi(m, "const s = doc.querySelector(arguments[0]); s.value = 'autre'; s.dispatchEvent(new ui.Event('change', { bubbles: true }));", [select], "agent");
    await waitFor(m, "return 1", () => read(pidFile) !== "" && read(pidFile) !== workshop, 20_000);
    expect(JSON.parse(read(join(dataDir, "workspace", "fake-agent-args.json")))).toEqual(["autre-agent", "--mcp", expect.stringMatching(SESSION_CONFIG)]);
    await terminalShows("fake agent ready>");
    expect(await inUi(m, "return doc.querySelector('[data-testid=\"agent-panel\"]').textContent", [], "agent")).not.toContain("L'agent s'est arrêté.");
  } finally {
    await w?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("the built-in profiles: Claude Code and Codex in the menu, signed-out ones marked (the fake docker has no account)", async () => {
  await launch();
  await openPanel();
  await terminalShows("fake agent ready>");
  expect(await waitUi(m, "const o = [...(doc.querySelector('[data-testid=\"agent-profile\"]')?.options ?? [])].map((x) => x.textContent.trim()); return o.length && o", [], 10_000, "agent")).toEqual([
    "Claude Code (non connecté)",
    "Codex (non connecté)",
  ]);
});

it("Claude on Ollama is not marked signed out in the menu: its subscription is not needed", async () => {
  await launch();
  await openPanel();
  await dispatch(m, { type: "chooseClaudeEngine", engine: { kind: "ollama", ollamaUrl: "http://host.docker.internal:11434", ollamaModel: "ornith:35b", apiUrl: "", apiModel: "" } });
  expect(await waitUi(m, "const o = [...(doc.querySelector('[data-testid=\"agent-profile\"]')?.options ?? [])].map((x) => x.textContent.trim()); return o[0] === 'Claude Code' && o[1] === 'Codex (non connecté)' && o", [], 10_000, "agent")).toEqual([
    "Claude Code",
    "Codex (non connecté)",
  ]);
});

it("a starting machine: the panel says « L'atelier démarre… » instead of « Préparation »", async () => {
  // Docker answers after 8 s: the panel stays on its preparation long enough to be read.
  await launch({ RESSAC_TEST_MACHINE: "starting", FAKE_DOCKER_SLOW: "1" });
  await openPanel();
  await panelShows("L'atelier démarre…");
  expect(await inUi(m, "return doc.querySelector('[data-testid=\"agent-panel\"]').textContent", [], "agent")).not.toContain("Préparation");
});

describe("the agent selector", () => {
  const SELECT = '[data-testid="agent-profile"]';
  const argsFile = () => join(w!.dataDir, "workspace", "fake-agent-args.json");
  const args = (): string[] => (read(argsFile()) ? JSON.parse(read(argsFile())) : []);
  const pick = (id: string) => inUi(m, "const s = doc.querySelector(arguments[0]); s.value = arguments[1]; s.dispatchEvent(new ui.Event('change', { bubbles: true }));", [SELECT, id], "agent");
  const argsAre = (first: string) => waitFor(m, "return 1", () => args()[0] === first, 20_000);

  it("switching to Codex opens a new conversation in this window only; switching back resumes; new windows take the last choice", async () => {
    await launch();
    await openPanel();
    await terminalShows("fake agent ready>");
    const a = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    const second = await newWindow(m);
    await inWindow(m, second, async () => {
      await openPanel();
      await terminalShows("fake agent ready>");
      await click(m, ".xterm-screen", { frame: "agent" });
      await send("avant");
      await terminalShows("received: avant");
    });
    // B's panel state is recorded from now on: it must never show the preparation again.
    await inWindow(m, second, () =>
      inUi(m, "ui.__seenPreparing = false; const t = () => { if (doc.querySelector('[data-testid=\"agent-panel\"]')?.textContent.includes('Préparation')) ui.__seenPreparing = true; }; ui.__obs = new ui.MutationObserver(t); ui.__obs.observe(doc.body, { subtree: true, childList: true, characterData: true });", [], "agent"),
    );
    await m.command("WebDriver:SwitchToWindow", { handle: a, focus: false });
    await pick("codex");
    await argsAre("codex");
    expect(args()).not.toContain("resume");
    await inWindow(m, second, async () => {
      expect(await inUi(m, "return ui.__seenPreparing", [], "agent")).toBe(false);
      expect(await terminalText()).toContain("received: avant");
      expect(await inUi(m, `return doc.querySelector(${JSON.stringify(SELECT)}).value`, [], "agent")).toBe("claude");
    });
    await pick("claude");
    await waitFor(m, "return 1", () => args().includes("--continue"), 20_000);
    await pick("codex");
    await waitFor(m, "return 1", () => args().includes("resume") && args().includes("--last"), 20_000);
    expect(args()[0]).toBe("codex");
    // A new window takes the last chosen agent.
    await pressKeys(m, "Meta+n");
    const third = (await waitWindowCount(m, 3)).find((h) => h !== a && h !== second)!;
    await inWindow(m, third, () => waitReady(m));
    await inWindow(m, third, async () => {
      await openPanel();
      await waitUi(m, `return doc.querySelector(${JSON.stringify(SELECT)})?.value === "codex"`, [], 20_000, "agent");
    });
  });

  it("Codex not signed in: a line and a button to Settings", async () => {
    await launch();
    await openPanel();
    await terminalShows("fake agent ready>");
    await pick("codex");
    await panelShows("Codex n'est pas connecté à votre compte ChatGPT.");
    await click(m, '[data-testid="agent-login-settings"]', { frame: "agent" });
    for (const end = Date.now() + 10_000; !Object.values((await state(m)).tabs).some((t) => t.url === "ressac://settings"); await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > end) throw new Error("Settings did not open");
  });
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
  await terminalShows("received: bonjour");
});

it("each key reaches the agent once and shows once, also after closing and reopening the panel", async () => {
  await launch();
  await homeAgent();
  const input = join(w!.dataDir, "workspace", "fake-agent-input.txt");
  await typeText(m, "xyz");
  await terminalShows("ready> xyz");
  // Time for a second copy to arrive.
  await new Promise((r) => setTimeout(r, 500));
  expect(read(input)).toBe("xyz");
  expect(await terminalText()).not.toContain("xxyy");
  await toggleWithButton();
  await hidden();
  await toggleWithButton();
  await shown();
  await waitUi(m, "return doc.activeElement?.classList.contains('xterm-helper-textarea')", [], 10_000, "agent");
  await typeText(m, "uv");
  await terminalShows("xyzuv");
  await new Promise((r) => setTimeout(r, 500));
  expect(read(input)).toBe("xyzuv");
  expect(await terminalText()).not.toContain("uuvv");
});

it("a keypress after a keydown the terminal consumed is not sent again (macOS, parent-process document)", async () => {
  await launch();
  await homeAgent();
  // Gecko's macOS widget still fires keypress for a printable key whose keydown was consumed, when the focused document
  // is in the parent process (BrowserChild drops it for web content). Headless has no native widget: the pair is replayed.
  await inUi(
    m,
    `const t = doc.querySelector(".xterm-helper-textarea");
     for (const c of "xyz") {
       t.dispatchEvent(new ui.KeyboardEvent("keydown", { key: c, code: "Key" + c.toUpperCase(), keyCode: c.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true }));
       t.dispatchEvent(new ui.KeyboardEvent("keypress", { key: c, code: "Key" + c.toUpperCase(), charCode: c.charCodeAt(0), bubbles: true, cancelable: true }));
     }`,
    [],
    "agent",
  );
  const input = join(w!.dataDir, "workspace", "fake-agent-input.txt");
  await waitFor(m, "return 1", () => read(input).length >= 3);
  await new Promise((r) => setTimeout(r, 500));
  expect(read(input)).toBe("xyz");
});

it("after Réessayer, each key still reaches the agent once and shows once", async () => {
  await launch({ FAKE_DOCKER_NO_CONTAINER: "1", FAKE_DOCKER_RUN_FAILED: "1" });
  await openPanel();
  await click(m, "button", { text: "Réessayer", frame: "agent" });
  await homeAgent();
  const input = join(w!.dataDir, "workspace", "fake-agent-input.txt");
  await typeText(m, "xyz");
  await terminalShows("ready> xyz");
  await new Promise((r) => setTimeout(r, 500));
  expect(read(input)).toBe("xyz");
  expect(await terminalText()).not.toContain("xxyy");
});

it("agent quits → Relancer starts a new one", async () => {
  await launch();
  await homeAgent();
  const pidFile = join(w!.dataDir, "workspace", "fake-agent-pid");
  const first = read(pidFile);
  await send("quit");
  await waitUi(m, "return doc.querySelector('[data-testid=\"agent-panel\"]').textContent.includes(\"L'agent s'est arrêté.\")", [], 10_000, "agent");
  await click(m, "button", { text: "Relancer", frame: "agent" });
  await waitFor(m, "return 1", () => read(pidFile) !== "" && read(pidFile) !== first, 20_000);
  await waitUi(m, "return !doc.querySelector('[data-testid=\"agent-panel\"]').textContent.includes(\"L'agent s'est arrêté.\")", [], 10_000, "agent");
});

it("a changed AGENTS.md shows the review card; Revenir restores it and the agent starts", async () => {
  await launch();
  await homeAgent();
  const file = join(w!.dataDir, "workspace", "AGENTS.md");
  const before = read(file);
  expect(before).not.toBe("");
  // The first session accepted these files; the agent changes one, then its session ends.
  writeFileSync(file, `${before}\nPLANTED INSTRUCTION\n`);
  await send("quit");
  await panelShows("L'agent s'est arrêté.", 10_000);
  await click(m, "button", { text: "Relancer", frame: "agent" });
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"agent-review\"]')", [], 20_000, "agent");
  await waitUi(m, "return doc.querySelector('[data-testid=\"agent-review\"]').textContent.includes('PLANTED INSTRUCTION')", [], 10_000, "agent");
  await click(m, '[data-testid="agent-review-revert"]', { frame: "agent" });
  await terminalShows("fake agent ready>");
  expect(read(file)).toBe(before);
});

it("closing and reopening the panel keeps the conversation", async () => {
  await launch();
  await homeAgent();
  await send("souvenir");
  await terminalShows("received: souvenir");
  await toggleWithButton();
  await hidden();
  await toggleWithButton();
  await shown();
  expect(await terminalText()).toContain("received: souvenir");
});

it("⌘T › « Panneau de l'agent » on home opens the panel with the terminal focused, not the home field", async () => {
  await launch();
  await pressKeys(m, "Meta+t");
  await waitUi(m, "return doc.activeElement?.dataset.testid === 'command-input'");
  await inUi(m, `const f = doc.activeElement; f.value = "agent"; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`);
  await waitUi(m, "return doc.querySelector('[data-testid=\"command-row\"][aria-selected=\"false\"][data-type=\"command\"]')?.textContent.includes('⌘J')");
  await pressKeys(m, "ArrowDown");
  await pressKeys(m, "Enter");
  await shown();
  await waitFor(m, "return document.activeElement?.id", (v) => v === "ressac-agent");
  await waitUi(m, "return doc.activeElement?.classList.contains('xterm-helper-textarea')", [], 10_000, "agent");
  // The home field's late focus (closeCommand's counter) must not take it back.
  await new Promise((r) => setTimeout(r, 500));
  expect(await m.execute("return document.activeElement?.id")).toBe("ressac-agent");
});

it("Docker absent → message and Réessayer", async () => {
  await launch({ FAKE_DOCKER_ABSENT: "1" });
  await openPanel();
  await waitUi(
    m,
    "return doc.querySelector('[data-testid=\"agent-panel\"]').textContent.includes(\"Docker n'est pas lancé. La navigation fonctionne ; seul l'agent est indisponible.\")",
    [],
    20_000,
    "agent",
  );
  await waitUi(m, "return [...doc.querySelectorAll('button')].some((b) => b.textContent === 'Réessayer')", [], 10_000, "agent");
});

it.each([
  ["reduced motion", 1],
  ["the slide", 0],
])("⌘J opens the panel and focuses the terminal (%s)", async (_, reduced) => {
  await launch(undefined, undefined, { "ui.prefersReducedMotion": reduced });
  await openTab("/a.html");
  await m.execute("gBrowser.selectedBrowser.focus()");
  await pressKeys(m, "Meta+j");
  await shown();
  await waitFor(m, "return document.activeElement?.id", (v) => v === "ressac-agent");
  await waitUi(m, "return doc.activeElement?.classList.contains('xterm-helper-textarea')", [], 10_000, "agent");
  // Keys typed next go to the agent, after the context prefix opening the panel wrote.
  await send("clavier");
  const input = join(w!.dataDir, "workspace", "fake-agent-input.txt");
  await waitFor(m, "return 1", () => read(input).includes(`[contexte : Page A — ${server.url}/a.html] clavier\r`));
  await pressKeys(m, "Meta+j");
  await hidden();
  // Closed from the terminal: the keyboard goes back to the page.
  await waitFor(m, "return document.activeElement === gBrowser.selectedBrowser", (v) => v === true);
});

it("the page narrows by the panel width", async () => {
  await launch();
  await openTab("/a.html");
  const width = await m.execute<number>("return window.innerWidth");
  // The page keeps 8 px of aura on its right.
  expect(await m.execute("return gBrowser.selectedBrowser.getBoundingClientRect().right")).toBe(width - 8);
  await toggleWithButton();
  await waitFor(m, "return gBrowser.selectedBrowser.getBoundingClientRect().right", (v) => v === width - 420 - 8);
  expect(await m.execute("return document.getElementById('ressac-agent').getBoundingClientRect().left")).toBe(width - 420);
});

it("with the sidebar on the right, the panel opens on the left and the page sits between", async () => {
  await launch();
  await openTab("/a.html");
  await dispatch(m, { type: "setSidebarSide", side: "right" });
  const width = await m.execute<number>("return window.innerWidth");
  const rect = (id: string) => m.execute<{ left: number; right: number }>(`const r = document.getElementById(arguments[0]).getBoundingClientRect(); return { left: r.left, right: r.right };`, [id]);
  await waitFor(m, "return gBrowser.selectedBrowser.getBoundingClientRect().right", (v) => v === width - 240);
  expect((await rect("ressac-sidebar")).right).toBe(width);
  expect(await m.execute("return gBrowser.selectedBrowser.getBoundingClientRect().left")).toBe(8);
  await toggleWithButton();
  await waitFor(m, "return gBrowser.selectedBrowser.getBoundingClientRect().left", (v) => v === 420 + 8);
  expect(await m.execute("return gBrowser.selectedBrowser.getBoundingClientRect().right")).toBe(width - 240);
  expect(await rect("ressac-agent")).toEqual({ left: 0, right: 420 });
});

it("opening the panel on a tab shares it, a first opening too (its new session takes accesses back): current_page reads without asking", async () => {
  await launch();
  await openTab("/texte.html");
  await toggleWithButton();
  await shown();
  await terminalShows("fake agent ready>");
  expect((await callTool(w!.dataDir, "current_page")).text).toContain("Le chat dort");
});

describe("one agent session per window", () => {
  const pidFile = () => join(w!.dataDir, "workspace", "fake-agent-pid");
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** The agent is killed, in the container too (the fake docker logs it). Polled here: there may be no window left to run in. */
  const stopped = async (pid: number) => {
    const deadline = Date.now() + 10_000;
    while (alive(pid)) {
      if (Date.now() > deadline) throw new Error(`the agent ${pid} still runs`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const log = join(w!.dataDir, "workspace", "fake-docker-stops.log");
    for (const end = Date.now() + 10_000; !/ressac-session-[0-9a-f]+\.pid[\s\S]*signaler KILL/.test(read(log)); await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > end) throw new Error(`no kill logged: ${read(log)}`);
  };

  it("⌘W on the empty page of the last window closes it and stops its agent", async () => {
    await launch();
    await openPanel();
    await terminalShows("fake agent ready>");
    const pid = Number(read(pidFile()));
    await pressClosing(m, "Meta+w");
    await waitWindowCount(m, 0);
    await stopped(pid);
  });

  it("⇧⌘W on the last window with a tab stops its agent; reopening it (Dock) starts a new one", async () => {
    await launch();
    await openPanel();
    await terminalShows("fake agent ready>");
    const pid = Number(read(pidFile()));
    await openTab("/a.html");
    // A module timer outlives the window: once it is gone, it reopens one as the Dock would.
    await m.execute(
      `const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
       const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
       const reopen = () => [...Services.wm.getEnumerator("navigator:browser")].length ? setTimeout(reopen, 100) : setTimeout(() => BrowserWindowTracker.openWindow(), 500);
       setTimeout(reopen, 100);`,
    );
    const old = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    await pressClosing(m, "Meta+Shift+w");
    await stopped(pid);
    const reopened = (await waitWindowCount(m, 1, 20_000)).find((h) => h !== old)!;
    await m.command("WebDriver:SwitchToWindow", { handle: reopened, focus: false });
    await waitReady(m);
    await openPanel();
    await terminalShows("fake agent ready>");
    const next = Number(read(pidFile()));
    expect(next).not.toBe(pid);
    expect(alive(next)).toBe(true);
  });

  it("closing a window stops its agent", async () => {
    await launch();
    // The first window's agent first: fake-agent-pid then becomes the second's.
    await openPanel();
    await terminalShows("fake agent ready>");
    const first = Number(read(pidFile()));
    const second = await newWindow(m);
    const pid = await inWindow(m, second, async () => {
      await openPanel();
      await terminalShows("fake agent ready>");
      await waitFor(m, "return 1", () => Number(read(pidFile())) !== first);
      return Number(read(pidFile()));
    });
    await inWindow(m, second, () => m.execute("window.close()"));
    await waitWindowCount(m, 1);
    await stopped(pid);
    expect(alive(first)).toBe(true);
  });

  it("focusing another window moves the agent there at once: current_page reads its public tab, not the other's private one", async () => {
    await launch();
    await openPanel();
    await terminalShows("fake agent ready>");
    const a = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    const second = await newWindow(m);
    const STORE = "chrome://browser/content/ressac/store.sys.mjs";
    const active = () => m.execute<string>(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).windows.active())()`);
    const focus = async (h: string) => {
      await m.command("WebDriver:SwitchToWindow", { handle: h, focus: true });
      const id = await m.execute<string>("return window.ressacWindow.windowId");
      for (const end = Date.now() + 10_000; (await active()) !== id; await new Promise((r) => setTimeout(r, 100)))
        if (Date.now() > end) throw new Error("the window did not become active");
      return id;
    };
    // B: its session up, then a public tab shared through the panel.
    const b = await inWindow(m, second, async () => {
      await openPanel();
      await terminalShows("fake agent ready>");
      await toggleWithButton();
      await hidden();
      return m.execute<string>("return window.ressacWindow.windowId");
    });
    await dispatch(m, { type: "openTab", windowId: b, url: `${server.url}/texte.html` });
    await dispatch(m, { type: "toggleAgentPanel", windowId: b });
    // A, focused: a tab in a private space; the private mirror is computed while A is active.
    const idA = await focus(a);
    const s = await dispatch(m, { type: "createSpace", name: "Secret", icon: "🔒", private: true, profile: "default", windowId: idA });
    await dispatch(m, { type: "openTab", windowId: idA, url: `${server.url}/a.html`, spaceId: s.spaces.at(-1)!.id });
    // Both pages loaded: no late title change may refresh the mirror after the focus.
    for (const end = Date.now() + 10_000; ; await new Promise((r) => setTimeout(r, 100))) {
      const titles = Object.values((await state(m)).tabs).map((o) => o.title).sort();
      if (titles.join() === "Page A,Texte") break;
      if (Date.now() > end) throw new Error(`pages not loaded: ${titles}`);
    }
    expect((await callTool(w!.dataDir, "current_page")).text).toBe("Cet onglet est dans un espace privé : l'agent n'y a pas accès.");
    // Focus B, with no state change.
    await focus(second);
    expect((await callTool(w!.dataDir, "current_page")).text).toContain("Le chat dort");
  });
});

/** The system clipboard's text (chrome context). */
const clipboardText = () =>
  m.execute<string>(`const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    t.init(null); t.addDataFlavor("text/plain");
    Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard, window.browsingContext.currentWindowContext);
    const o = {}; try { t.getTransferData("text/plain", o); } catch { return ""; }
    return o.value.QueryInterface(Ci.nsISupportsString).data;`);

it("text selected in the terminal by dragging is copied by ⌘C", async () => {
  await launch();
  await homeAgent();
  await m.execute(`Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("avant");`);
  // A drag across the first row ("fake agent ready>").
  await inUi(
    m,
    `const r = doc.querySelector(".xterm-rows > div").getBoundingClientRect();
     const y = r.top + r.height / 2;
     ui.synthesizeMouseEvent("mousedown", r.left + 1, y, { button: 0, clickCount: 1 });
     for (let x = r.left + 10; x < r.left + 300; x += 20) ui.synthesizeMouseEvent("mousemove", x, y, { button: 0 });
     ui.synthesizeMouseEvent("mouseup", r.left + 300, y, { button: 0, clickCount: 1 });`,
    [],
    "agent",
  );
  await pressKeys(m, "Meta+c");
  await expect.poll(clipboardText, { timeout: 5_000 }).toContain("fake agent");
});

it("text the agent copies itself (OSC 52, Claude Code's mouse selection) reaches the clipboard", async () => {
  await launch();
  await homeAgent();
  await send("osc52");
  await expect.poll(clipboardText, { timeout: 5_000 }).toBe("copié par l'agent ✓");
});

it("sites get the engine's plain Firefox user agent, with no Ressac token (WhatsApp Web refuses it)", async () => {
  await launch();
  const ua = await m.execute<string>(`return Cc["@mozilla.org/network/protocol;1?name=http"].getService(Ci.nsIHttpProtocolHandler).userAgent`);
  expect(ua).toMatch(/ Gecko\/20100101 Firefox\/\d+\.\d+$/);
});

it("a link the agent prints (OSC 8, Claude Code's sign-in address) opens in a tab, with no dialog", async () => {
  await launch();
  await homeAgent();
  await send("link");
  await terminalShows("sign-in-link sign-in-link");
  // xterm activates the link under the pointer: a move first, then the press.
  await inUi(
    m,
    `const row = [...doc.querySelectorAll(".xterm-rows > div")].find((e) => e.textContent.startsWith("sign-in-link"));
     const r = row.getBoundingClientRect();
     const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
     ui.synthesizeMouseEvent("mousemove", x, y, {});
     await new Promise((r) => setTimeout(r, 300));
     for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, x, y, { button: 0, clickCount: 1 });`,
    [],
    "agent",
  );
  await waitFor(m, "return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === 'https://sign-in.invalid/oauth?code=1' || t.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI?.spec.includes('sign-in.invalid'))", (v) => v === true);
});

it("⌘J: the terminal takes the keyboard back when the window's focus is lost during the slide", async () => {
  await launch(undefined, undefined, { "ui.prefersReducedMotion": 0 });
  await openTab("/a.html");
  await m.execute("gBrowser.selectedBrowser.focus()");
  // The loss, without a race against the panel's retries (100 and 500 ms): for 150 ms from the first request, the
  // frame's focus does nothing, as when the window's focus is lost in the handover. No timer on this side, which a
  // loaded machine fires late (measured: a 200 ms timer at 577 ms, after the last retry).
  await m.execute(`const frame = document.getElementById("ressac-agent");
    const focus = frame.focus.bind(frame);
    let first;
    window.ressacTestLost = [];
    frame.focus = (...a) => {
      first ??= performance.now();
      if (performance.now() - first >= 150) return focus(...a);
      queueMicrotask(() => window.ressacTestLost.push(document.activeElement?.id || document.activeElement?.localName));
    };`);
  await pressKeys(m, "Meta+j");
  await shown();
  await waitFor(m, "return document.activeElement?.id", (v) => v === "ressac-agent");
  await waitUi(m, "return doc.activeElement?.classList.contains('xterm-helper-textarea')", [], 10_000, "agent");
  // The first requests were lost for real: the keyboard was still on the page after them.
  expect(await m.execute<string[]>("return window.ressacTestLost")).toContain("browser");
});

it("the first build shows its step and the elapsed minutes in the panel", async () => {
  await launch({ FAKE_DOCKER_NO_CONTAINER: "1", FAKE_DOCKER_BUILD_STEP_MS: "2000" });
  await openPanel();
  await waitUi(m, "return (doc.querySelector('[data-testid=agent-build-step]')?.textContent ?? '').includes(arguments[0])", ["étape 2/3 : Outils système… (moins d'une min)"], 20_000, "agent");
  await terminalShows("fake agent ready>", 30_000);
});
