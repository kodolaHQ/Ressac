import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initialState } from "../core/state/initial-state";
import { FIRST_TIME, type FirstTimeId } from "../shared/hints";
import { tid, uiQueries, writeAction } from "./actions";
import { inStore } from "./design-sites";
import { dispatch, state, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, pressKeys, waitUi } from "./ui";

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
async function launch(o: { lab?: boolean; ai?: boolean } = {}): Promise<void> {
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
  // No way in from the sidebar either (the agent's button is there: the sidebar has rendered its tools).
  await waitUi(m, "return !!doc.querySelector(arguments[0]) && !doc.querySelector(arguments[1])", [tid("agent-button"), tid("actions-button")]);
});

/** The host's answer to a tier-3 request: "lab-off" while it is off. */
const actionsAnswer = () => inStore<string>(m, `return await store.agent.request("actions.list").then(() => "answered", (e) => e.message);`);
/** Réglages › Agent, open. */
async function agentSettings(): Promise<void> {
  await click(m, tid("settings-button"));
  await click(m, tid("settings-nav-agent"));
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [tid("settings-lab-switch")]);
}
const labSwitch = () => inUi<{ checked: boolean; disabled: boolean }>(m, "const s = doc.querySelector(arguments[0]); return { checked: s.checked, disabled: s.disabled };", [tid("settings-lab-switch")]);
/** The agent panel's Atelier choice: its text and whether it takes a press. */
const workshopChoice = () =>
  inUi<{ text: string; disabled: boolean; title: string } | null>(
    m,
    "const b = doc.querySelector(arguments[0]); return b && { text: b.textContent.trim(), disabled: b.disabled, title: b.title };",
    [tid("agent-mode-workshop")],
    "agent",
  );

it("la carte du labo : Échap n'active rien", { timeout: 90_000 }, async () => {
  await launch({ lab: false });
  await expect.poll(actionsAnswer, { timeout: 30_000 }).toBe("lab-off");
  await agentSettings();
  await click(m, tid("settings-lab-switch"));
  await waitUi(m, "return !!doc.activeElement?.closest(arguments[0])", [tid("lab-card")]);
  expect((await labSwitch()).checked).toBe(false);
  await pressKeys(m, "Escape");
  // Gone once its fade has ended.
  await waitUi(m, "return !doc.querySelector(arguments[0])", [tid("lab-card")]);
  expect((await state(m)).settings.lab).toBe(false);
  expect((await labSwitch()).checked).toBe(false);
  // The host was never told: it still refuses.
  expect(await actionsAnswer()).toBe("lab-off");
});

it("J'ai compris, activer", { timeout: 90_000 }, async () => {
  await launch({ lab: false });
  await click(m, tid("agent-button"));
  await expect.poll(workshopChoice, { timeout: 30_000 }).toEqual({ text: "Atelier (labo)", disabled: true, title: "Demande le labo : Réglages › Agent" });
  await agentSettings();
  await click(m, tid("settings-lab-switch"));
  // `click` waits for the button to take the pointer (armed after ARM_MS).
  await click(m, tid("lab-card-accept"));
  await expect.poll(async () => (await state(m)).settings.lab).toBe(true);
  await waitUi(m, "return !doc.querySelector(arguments[0]) && doc.querySelector(arguments[1]).checked", [tid("lab-card"), tid("settings-lab-switch")]);
  await expect.poll(workshopChoice).toMatchObject({ text: "Atelier", disabled: false });
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [tid("actions-button")]);
  await expect.poll(actionsAnswer, { timeout: 30_000 }).toBe("answered");
});

it("éteindre le labo ne demande rien et repasse en Navigateur", { timeout: 90_000 }, async () => {
  await launch();
  await expect.poll(async () => (await state(m)).settings.lab, { timeout: 30_000 }).toBe(true);
  const windowId = (await state(m)).windows[0]!.id;
  await dispatch(m, { type: "chooseAgentMode", mode: "workshop" });
  expect((await state(m)).settings.agentMode).toBe("workshop");
  // A site app in the essentials, its tab open: tier 3, that tab closes with the lab (the essential gets a fresh one,
  // which the host no longer gives the app's tweaks).
  await dispatch(m, { type: "placeSite", id: "vidola", placement: "essentials", url: "http://127.0.0.1:9/", title: "Vidola" });
  const essential = (await state(m)).essentials.find((x) => x.site === "vidola")!.id;
  await dispatch(m, { type: "openFavorite", windowId, kind: "essential", id: essential });
  const essentialTab = async () => Object.values((await state(m)).tabs).find((o) => o.link?.id === essential)?.id;
  const before = await essentialTab();
  expect(before).toBeDefined();
  await agentSettings();
  expect((await labSwitch()).checked).toBe(true);
  await click(m, tid("settings-lab-switch"));
  await expect.poll(async () => (await state(m)).settings).toMatchObject({ lab: false, agentMode: "browser" });
  // The card would have opened in the same change handler.
  expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [tid("lab-card")])).toBe(false);
  await expect.poll(async () => Object.keys((await state(m)).tabs)).not.toContain(before);
  // The essential itself stays: nothing is deleted.
  expect((await state(m)).essentials.some((x) => x.id === essential)).toBe(true);
});

it("le labo est grisé quand l'IA est éteinte", { timeout: 90_000 }, async () => {
  await launch({ lab: false, ai: false });
  await agentSettings();
  expect(await labSwitch()).toEqual({ checked: false, disabled: true });
});
