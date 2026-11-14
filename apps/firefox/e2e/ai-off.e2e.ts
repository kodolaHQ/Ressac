import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { initialState } from "../core/state/initial-state";
import { FIRST_TIME, type FirstTimeId } from "../shared/hints";
import { listen, type TestServer } from "./actions";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { waitUi } from "./ui";

// AI off: no docker command, no Ollama request. The fake docker writes every call to fake-docker-all.log.
let ollama: TestServer;
let w: LaunchedRessac | undefined;
let m: Marionette;
let dataDir: string | undefined;
beforeAll(async () => (ollama = await listen((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}'))));
afterAll(() => ollama?.close());
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

async function launch(ai: boolean): Promise<void> {
  // A session that starts on the home page, whose one-time notes are seen.
  dataDir = await mkdtemp(join(os.tmpdir(), "ressac-data-"));
  const s = initialState();
  s.settings.hints.seen = Object.keys(FIRST_TIME) as FirstTimeId[];
  s.settings.startOnHome = true;
  s.settings.language = "fr";
  await writeFile(join(dataDir, "session.json"), JSON.stringify(s));
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
