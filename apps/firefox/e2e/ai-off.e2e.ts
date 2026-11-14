import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { initialState } from "../core/state/initial-state";
import { FIRST_TIME, type FirstTimeId } from "../shared/hints";
import { listen, tid, writeAction, type TestServer } from "./actions";
import { openTab } from "./agent-extensions";
import { writeProject } from "./apps";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, pressKeys, waitUi, type Frame } from "./ui";

const STORE = "chrome://browser/content/ressac/store.sys.mjs";

// AI off: no docker command, no Ollama request. The fake docker writes every call to fake-docker-all.log.
let ollama: TestServer;
let web: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac | undefined;
let m: Marionette;
let dataDir: string | undefined;
beforeAll(async () => {
  ollama = await listen((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}'));
  web = await startServer();
});
afterAll(async () => {
  await ollama?.close();
  await web?.close();
});
afterEach(async () => {
  await w?.close();
  w = undefined;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

const dockerCalls = () => {
  const file = join(w!.dataDir, "workspace", "fake-docker-all.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
};

async function launch(ai: boolean, prepare?: (dataDir: string) => Promise<void>): Promise<void> {
  // A session that starts on the home page, whose one-time notes are seen.
  dataDir = await mkdtemp(join(os.tmpdir(), "ressac-data-"));
  const s = initialState();
  s.settings.hints.seen = Object.keys(FIRST_TIME) as FirstTimeId[];
  s.settings.startOnHome = true;
  s.settings.language = "fr";
  await writeFile(join(dataDir, "session.json"), JSON.stringify(s));
  await prepare?.(dataDir);
  w = await launchRessac({ ai, dataDir, env: { RESSAC_OLLAMA_URL: ollama.url } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
}

it("off: no docker call and no Ollama request at launch on home", async () => {
  ollama.log.length = 0;
  await launch(false);
  await new Promise((r) => setTimeout(r, 5_000));
  expect(dockerCalls()).toEqual([]);
  expect(ollama.log).toEqual([]);
  expect((await state(m)).windows[0]!.agentPanelOpen).toBe(false);
});

it("switching on wakes the kernel", async () => {
  await launch(false);
  await dispatch(m, { type: "enableAi" });
  await waitFor(m, "return 1", () => dockerCalls().some((l) => /^(info|build)\b/.test(l)), 10_000);
});

it("switching off live stops the agent and nothing runs docker afterwards", { timeout: 150_000 }, async () => {
  await launch(true);
  await waitFor(m, "return !document.getElementById('ressac-agent').hidden", (v) => v === true);
  await waitUi(m, "return (doc.querySelector('.xterm-rows')?.textContent ?? '').includes('fake agent ready>')", [], 20_000, "agent");
  const pid = Number(readFileSync(join(w!.dataDir, "workspace", "fake-agent-pid"), "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const before = dockerCalls().length;
  await dispatch(m, { type: "disableAi" });
  expect((await state(m)).windows[0]!.agentPanelOpen).toBe(false);
  await waitFor(m, "return 1", () => !alive(), 10_000);
  // The stops run right after the switch; then nothing, past the scheduler's next 60 s tick.
  await new Promise((r) => setTimeout(r, 5_000));
  const settled = dockerCalls();
  expect(settled.slice(before).filter((l) => !/^(stop|rm|exec)\b/.test(l))).toEqual([]);
  await new Promise((r) => setTimeout(r, 65_000));
  expect(dockerCalls().slice(settled.length)).toEqual([]);
});

const shown = (selector: string, frame: Frame = "sidebar") => waitUi(m, "return !!doc.querySelector(arguments[0])", [selector], 10_000, frame);
const panelShown = (open: boolean) => waitFor(m, "return !document.getElementById('ressac-agent').hidden", (v) => v === open);

it("off: shortcuts show the asleep card and start nothing", async () => {
  await launch(false);
  await pressKeys(m, "Meta+j");
  await panelShown(true);
  await shown(tid("ai-asleep-agent"), "agent");
  await new Promise((r) => setTimeout(r, 2_000));
  expect(dockerCalls()).toEqual([]);
  // « Plus tard » closes the panel.
  await click(m, tid("ai-asleep-later"), { frame: "agent" });
  await panelShown(false);
  await pressKeys(m, "Meta+Shift+a");
  await shown(tid("ai-asleep-apps"));
  // Design mode on a web page: the agent panel opens on its card instead.
  await openTab(m, `${web.url}/a.html`);
  await pressKeys(m, "Meta+Shift+d");
  await panelShown(true);
  await shown(tid("ai-asleep-agent"), "agent");
  expect(await m.execute(`return (async () => { const d = (await ChromeUtils.importESModule("${STORE}").ready).design; return (await d.state({ type: "window", windowId: window.ressacWindow.windowId })).active; })();`)).toBe(false);
  expect(dockerCalls()).toEqual([]);
});

it("off: AI pages show the asleep card, action suggestions are hidden", async () => {
  await launch(false, async (d) => {
    await writeAction(d, "tickets", { name: "Tickets GitLab", keywords: ["tickets"] });
    writeProject(d, "tickets", { manifest: { name: "Tickets board" } });
  });
  await shown(tid("ai-asleep-widgets"));
  expect(await inUi(m, "return !!doc.querySelector('[data-testid=\"home-empty\"]')")).toBe(false);
  await inUi(m, `const f = doc.querySelector('${tid("empty-page-input")}'); f.value = "tickets"; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`);
  await new Promise((r) => setTimeout(r, 1_000));
  expect(await inUi(m, "return doc.querySelectorAll('[id^=\"suggestion-action-\"]').length")).toBe(0);
  await pressKeys(m, "Meta+t");
  await waitUi(m, `return doc.activeElement?.dataset.testid === "command-input"`);
  await inUi(m, `const f = doc.activeElement; f.value = "tickets"; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`);
  await new Promise((r) => setTimeout(r, 1_000));
  expect(await inUi(m, `return doc.querySelectorAll('${tid("command-row")}[data-type="action"], ${tid("command-row")}[data-type="app"]').length`)).toBe(0);
  await pressKeys(m, "Escape");
  await click(m, tid("actions-button"));
  await shown(tid("ai-asleep-actions"));
  await dispatch(m, { type: "openWorkflow", windowId: (await state(m)).windows[0]!.id, id: "starter", name: "Starter" });
  await shown(tid("ai-asleep-workflows"));
  const windowId = (await state(m)).windows[0]!.id;
  await dispatch(m, { type: "openAction", windowId, id: "tickets", name: "Tickets GitLab" });
  await shown(`${tid("content-zone")} ${tid("ai-asleep-actions")}`);
  await dispatch(m, { type: "openReview", windowId, project: "app-tickets", name: "Tickets board" });
  await shown(tid("ai-asleep-review"));
  await click(m, tid("settings-button"));
  await shown(tid("settings-ai-switch"));
  await shown(tid("ai-asleep-settings"));
  expect(await inUi(m, `return !!doc.querySelector('${tid("agent-claude")}')`)).toBe(false);
  expect(dockerCalls()).toEqual([]);
  expect(ollama.log).toEqual([]);
});

it("off: « Activer l'IA » on the card turns AI on", async () => {
  await launch(false);
  await pressKeys(m, "Meta+j");
  await shown(tid("ai-asleep-agent"), "agent");
  await click(m, tid("ai-asleep-enable"), { frame: "agent" });
  await expect.poll(async () => (await state(m)).settings.aiEnabled, { timeout: 10_000 }).toBe(true);
});

it("off: Demander shows the asleep line and nothing reaches Ollama or the agent", async () => {
  ollama.log.length = 0;
  await launch(false);
  await pressKeys(m, "Meta+t");
  await waitUi(m, `return doc.activeElement?.dataset.testid === "command-input"`);
  await pressKeys(m, "Tab");
  await shown(tid("ai-asleep-ask"));
  await inUi(m, `const f = doc.activeElement; f.value = "c'était quoi la page sur les mascarets"; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`);
  await pressKeys(m, "Enter");
  await new Promise((r) => setTimeout(r, 2_000));
  expect(await inUi(m, `return doc.querySelectorAll('${tid("command-ask-hit")}, ${tid("command-ask-agent")}, ${tid("command-ask-working")}').length`)).toBe(0);
  expect(await inUi(m, `return !!doc.querySelector('${tid("command-bar")}')`)).toBe(true);
  const s = await state(m);
  expect(s.windows[0]!.agentPanelOpen).toBe(false);
  expect(s.settings.aiEnabled).toBe(false);
  expect(ollama.log).toEqual([]);
  expect(dockerCalls()).toEqual([]);
});
