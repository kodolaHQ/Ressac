import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initialState } from "../core/state/initial-state";
import { FIRST_TIME, type FirstTimeId } from "../shared/hints";
import { tid, uiQueries, writeAction } from "./actions";
import { inStore } from "./design-sites";
import { state, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click } from "./ui";

// Tier 3 (« labo »): what an old session keeps, and what the host refuses while it is off.
let w: LaunchedRessac | undefined;
let m: Marionette;
let dataDir: string | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

/** A session saved before tiers (`lab` absent), AI on, with the agent's action « rappel » in the workspace. */
async function launch(o: { lab?: boolean } = {}): Promise<void> {
  dataDir = await mkdtemp(join(os.tmpdir(), "ressac-data-"));
  const s = initialState();
  s.settings.hints.seen = Object.keys(FIRST_TIME) as FirstTimeId[];
  s.settings.onboarded = true;
  s.settings.aiEnabled = true;
  s.settings.language = "fr";
  const { lab: _, ...settings } = s.settings;
  await writeFile(join(dataDir, "session.json"), JSON.stringify({ ...s, settings }));
  await writeAction(dataDir, "rappel", { name: "Rappel" });
  w = await launchRessac({ dataDir, ...o });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
}

it("une ancienne session garde le labo", { timeout: 90_000 }, async () => {
  await launch();
  // chrome ensure → lab.decide (an action in actions/) → decideLab.
  await expect.poll(async () => (await state(m)).settings.lab, { timeout: 30_000 }).toBe(true);
  await click(m, tid("actions-button"));
  await uiQueries(m).waitContains(tid("action-row-rappel"), "Rappel", 30_000);
});

it("labo éteint : les actions ne répondent plus", { timeout: 90_000 }, async () => {
  await launch({ lab: false });
  expect((await state(m)).settings.lab).toBe(false);
  // The host refuses, whatever the UI shows (polled: the host may still be starting).
  const answer = () => inStore<string>(m, `return await store.agent.request("actions.list").then(() => "answered", (e) => e.message);`);
  await expect.poll(answer, { timeout: 30_000 }).toBe("lab-off");
});
