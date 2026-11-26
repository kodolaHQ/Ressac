import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, pressKeys, typeText, waitUi } from "./ui";

// 0.1.14, small Macs: under macOS memory pressure an idle agent session sleeps (its process ends, so the machine can
// stop); the next key resumes the conversation. RESSAC_TEST_AGENT_SLEEP_MS stands for the 2 minutes of quiet.

const QUIET_MS = 4000;
let w: LaunchedRessac;
let m: Marionette;
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const workspace = (name: string) => join(w.dataDir, "workspace", name);
const relieves = () => read(workspace("fake-machine-calls.log")).split("\n").filter((l) => l === "relieve").length;
const press = () => m.execute(`Services.obs.notifyObservers(null, "memory-pressure", "low-memory");`);
const alive = (pid: string) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};
const TERMINAL = "return (doc.querySelector('.xterm-rows')?.textContent ?? '').replace(/\\u00a0/g, ' ')";
const terminalShows = (text: string) => waitUi(m, `${TERMINAL}.includes(arguments[0])`, [text], 20_000, "agent");
const asleepShown = () => inUi<boolean>(m, "return !!doc.querySelector('[data-testid=\"agent-asleep\"]')", [], "agent");

beforeAll(async () => {
  w = await launchRessac({
    env: { RESSAC_TEST_MACHINE: "running", RESSAC_TEST_AGENT_SLEEP_MS: String(QUIET_MS), RESSAC_EMBED_URL: "http://127.0.0.1:9" },
  });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await click(m, '[data-testid="agent-button"]');
  await terminalShows("fake agent ready>");
  await click(m, ".xterm-screen", { frame: "agent" });
});
afterAll(() => w?.close());

it("a session that just worked is left alone; once quiet it sleeps, and the next message resumes its conversation", async () => {
  const pid = read(workspace("fake-agent-pid"));
  const started: string[] = JSON.parse(read(workspace("fake-agent-args.json")));
  const id = started[started.indexOf("--session-id") + 1]!;
  await typeText(m, "ab");
  await pressKeys(m, "Enter");
  await terminalShows("received: ab");
  await press();
  await waitFor(m, "return 1", () => relieves() === 1, 10_000);
  expect(alive(pid)).toBe(true);
  expect(await asleepShown()).toBe(false);

  await new Promise((r) => setTimeout(r, QUIET_MS + 500));
  await press();
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"agent-asleep\"]')", [], 10_000, "agent");
  await waitFor(m, "return 1", () => relieves() === 2, 10_000);
  // Stopped before the machine was relieved.
  expect(alive(pid)).toBe(false);
  // The conversation's screen stays under the line.
  expect(await inUi<string>(m, TERMINAL, [], "agent")).toContain("received: ab");

  await typeText(m, "hello");
  await pressKeys(m, "Enter");
  await waitFor(m, "return 1", () => read(workspace("fake-agent-pid")) !== pid, 20_000);
  expect(JSON.parse(read(workspace("fake-agent-args.json"))).join(" ")).toContain(`--resume ${id}`);
  await terminalShows("received: hello");
  expect(await asleepShown()).toBe(false);
});
