import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, inWindow, newWindow, pressClosing, state, waitFor, waitReady, waitWindowCount } from "./firefox";
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

async function launch(env?: Record<string, string>, dataDir?: string): Promise<void> {
  w = await launchWebAiOs({ env, dataDir });
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
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${server.url}${path}` });
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
  await terminalShows("fake agent ready>");
  await click(m, ".xterm-screen", { frame: "agent" });
}
async function send(text: string): Promise<void> {
  await typeText(m, text);
  await pressKeys(m, "Enter");
}

it("the home page opens the panel, which runs the fake agent", async () => {
  await launch();
  await shown();
  await terminalShows("fake agent ready>");
  expect(await inUi(m, "return [...(ui.webaiosMissingApi ?? [])]", [], "agent")).toEqual([]);
});

const SESSION_CONFIG = /^\/workspace\/\.webaios\/sessions\/[0-9a-f]{16}\.json$/;
const panelShows = (text: string, ms = 20_000) =>
  waitUi(m, "return doc.querySelector('[data-testid=\"panneau-agent\"]').textContent.includes(arguments[0])", [text], ms, "agent");
const retryButton = () => waitUi(m, "return [...doc.querySelectorAll('button')].some((b) => b.textContent === 'Réessayer')", [], 10_000, "agent");

it("without Docker, browsing works", async () => {
  await launch({ FAKE_DOCKER_ABSENT: "1" });
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${server.url}/a.html` });
  await waitFor(m, "return gBrowser.selectedBrowser.contentTitle", (v) => v === "Page A");
});

it("the home page's panel runs the real CLI with the session's MCP config", async () => {
  await launch();
  await shown();
  await terminalShows("fake agent ready>");
  expect(JSON.parse(read(join(w!.dataDir, "workspace", "fake-agent-args.json")))).toEqual([
    "claude",
    "--dangerously-skip-permissions",
    "--mcp-config",
    expect.stringMatching(SESSION_CONFIG),
  ]);
});

it("a huge output does not freeze the UI", async () => {
  await launch();
  await homeAgent();
  await send("flood");
  // 1 MB later, the command has scrolled off the screen and the prompt is back at the bottom.
  await waitUi(m, `const t = ${TERMINAL.slice("return ".length)}; return !t.includes("received: flood") && t.includes("ready>")`, [], 20_000, "agent");
  expect(read(join(w!.dataDir, "workspace", "fake-agent-input.txt"))).toContain("flood\r");
  await click(m, '[data-testid="nouvel-onglet"]');
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"page-vide\"]')", [], 10_000);
});

it("a container that cannot start → error and Réessayer", async () => {
  await launch({ FAKE_DOCKER_FAILURE: "1" });
  await shown();
  await panelShows("L'agent n'a pas pu démarrer :");
  await panelShows("échec simulé");
  await retryButton();
});

it("a second profile in .webaios/profiles appears in the panel; choosing it restarts the agent with its command", async () => {
  const dataDir = mkdtempSync(join(os.tmpdir(), "webaios-data-"));
  try {
    mkdirSync(join(dataDir, "workspace", ".webaios", "profiles"), { recursive: true });
    writeFileSync(
      join(dataDir, "workspace", ".webaios", "profiles", "autre.json"),
      JSON.stringify({ id: "autre", name: "Autre", interactive: ["autre-agent", "--mcp", "{mcpConfig}"], nonInteractive: ["autre-agent", "-p", "{consigne}"], mcpConfig: "claude-json" }),
    );
    await launch(undefined, dataDir);
    await shown();
    await terminalShows("fake agent ready>");
    const pidFile = join(dataDir, "workspace", "fake-agent-pid");
    const first = read(pidFile);
    const select = '[data-testid="profil-agent"]';
    expect(await waitUi(m, "const o = [...(doc.querySelector(arguments[0])?.options ?? [])].map((x) => x.textContent.trim()); return o.length && o", [select], 10_000, "agent")).toEqual([
      "Autre",
      "Claude Code",
    ]);
    await inUi(m, "const s = doc.querySelector(arguments[0]); s.value = 'autre'; s.dispatchEvent(new ui.Event('change', { bubbles: true }));", [select], "agent");
    await waitFor(m, "return 1", () => read(pidFile) !== "" && read(pidFile) !== first, 20_000);
    expect(JSON.parse(read(join(dataDir, "workspace", "fake-agent-args.json")))).toEqual(["autre-agent", "--mcp", expect.stringMatching(SESSION_CONFIG)]);
    await terminalShows("fake agent ready>");
    expect(await inUi(m, "return doc.querySelector('[data-testid=\"panneau-agent\"]').textContent", [], "agent")).not.toContain("L'agent s'est arrêté.");
  } finally {
    await w?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("a single profile: no profile menu", async () => {
  await launch();
  await shown();
  await terminalShows("fake agent ready>");
  expect(await inUi(m, "return doc.querySelectorAll('[data-testid=\"profil-agent\"]').length", [], "agent")).toBe(0);
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
  await shown();
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
  await waitUi(m, "return doc.querySelector('[data-testid=\"panneau-agent\"]').textContent.includes(\"L'agent s'est arrêté.\")", [], 10_000, "agent");
  await click(m, "button", { text: "Relancer", frame: "agent" });
  await waitFor(m, "return 1", () => read(pidFile) !== "" && read(pidFile) !== first, 20_000);
  await waitUi(m, "return !doc.querySelector('[data-testid=\"panneau-agent\"]').textContent.includes(\"L'agent s'est arrêté.\")", [], 10_000, "agent");
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

it("Docker absent → message and Réessayer", async () => {
  await launch({ FAKE_DOCKER_ABSENT: "1" });
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
  await terminalShows("fake agent ready>");
  await openTab("/a.html");
  await m.execute("gBrowser.selectedBrowser.focus()");
  await pressKeys(m, "Meta+j");
  await shown();
  await waitFor(m, "return document.activeElement?.id", (v) => v === "webaios-agent");
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
  expect(await m.execute("return gBrowser.selectedBrowser.getBoundingClientRect().right")).toBe(width);
  await toggleWithButton();
  await waitFor(m, "return gBrowser.selectedBrowser.getBoundingClientRect().right", (v) => v === width - 420);
  expect(await m.execute("return document.getElementById('webaios-agent').getBoundingClientRect().left")).toBe(width - 420);
});

it("opening the panel on a tab shares it: current_page reads without asking", async () => {
  await launch();
  // The session started on the home page: a new one would take the access back.
  await terminalShows("fake agent ready>");
  await openTab("/texte.html");
  await toggleWithButton();
  await shown();
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
    const log = join(w!.dataDir, "workspace", "faux-docker-arrets.log");
    for (const end = Date.now() + 10_000; !/webaios-session-[0-9a-f]+\.pid[\s\S]*signaler KILL/.test(read(log)); await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > end) throw new Error(`no kill logged: ${read(log)}`);
  };

  it("⌘W on the empty page of the last window closes it and stops its agent", async () => {
    await launch();
    await shown();
    await terminalShows("fake agent ready>");
    const pid = Number(read(pidFile()));
    await pressClosing(m, "Meta+w");
    await waitWindowCount(m, 0);
    await stopped(pid);
  });

  it("⇧⌘W on the last window with a tab stops its agent; reopening it (Dock) starts a new one", async () => {
    await launch();
    await shown();
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
    await toggleWithButton();
    await shown();
    await terminalShows("fake agent ready>");
    const next = Number(read(pidFile()));
    expect(next).not.toBe(pid);
    expect(alive(next)).toBe(true);
  });

  it("closing a window stops its agent", async () => {
    await launch();
    // The first window's agent first: fake-agent-pid then becomes the second's.
    await shown();
    await terminalShows("fake agent ready>");
    const first = Number(read(pidFile()));
    const second = await newWindow(m);
    const pid = await inWindow(m, second, async () => {
      await shown();
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
    await shown();
    await terminalShows("fake agent ready>");
    const a = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    const second = await newWindow(m);
    const STORE = "chrome://browser/content/webaios/store.sys.mjs";
    const active = () => m.execute<string>(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).windows.active())()`);
    const focus = async (h: string) => {
      await m.command("WebDriver:SwitchToWindow", { handle: h, focus: true });
      const id = await m.execute<string>("return window.webaiosWindow.windowId");
      for (const end = Date.now() + 10_000; (await active()) !== id; await new Promise((r) => setTimeout(r, 100)))
        if (Date.now() > end) throw new Error("the window did not become active");
      return id;
    };
    // B: its session up, then a public tab shared through the panel.
    const b = await inWindow(m, second, async () => {
      await shown();
      await terminalShows("fake agent ready>");
      return m.execute<string>("return window.webaiosWindow.windowId");
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
