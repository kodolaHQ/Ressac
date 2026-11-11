import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch, state, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// Plan 50 Task 2: Settings › Raccourcis.

let w: LaunchedWebAiOs;
let m: Marionette;
beforeEach(async () => {
  w = await launchWebAiOs({ env: { WEBAIOS_OLLAMA_URL: "http://127.0.0.1:9" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await click(m, '[data-testid="settings-button"]');
  await click(m, '[data-testid="settings-nav-shortcuts"]');
  await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="shortcut-agent"]']);
});
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
  }
});

const text = (sel: string) => inUi<string>(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').trim() ?? ''", [sel]);
const row = (id: string) => text(`[data-testid="shortcut-${id}"]`);
const has = (sel: string) => inUi<boolean>(m, "return !!doc.querySelector(arguments[0])", [sel]);
const agentOpen = async () => (await state(m)).windows[0]!.agentPanelOpen;
const waitAlert = (msg: string) => waitUi(m, "return doc.querySelector('[data-testid=\"shortcut-agent\"] [role=alert]')?.textContent === arguments[0]", [msg]);
const edit = async (id: string) => {
  await click(m, `[data-testid="shortcut-${id}-edit"]`);
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="shortcut-${id}-prompt"]`]);
};

describe("Settings › Raccourcis", () => {
  it("remaps, refuses, cancels and resets", async () => {
    expect(await text('[data-testid="shortcut-agent-key"]')).toBe("⌘J");

    await edit("agent");
    expect(await row("agent")).toContain("Appuyez sur la nouvelle combinaison…");
    await pressKeys(m, "Meta"); // a bare modifier does not end the capture
    expect(await has('[data-testid="shortcut-agent-prompt"]')).toBe(true);
    await pressKeys(m, "Meta+k");
    await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="shortcut-agent-reset"]']);
    expect(await text('[data-testid="shortcut-agent-key"]')).toBe("⌘K");
    expect(await agentOpen()).toBe(false); // ⌘K did not run while capturing

    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: "about:blank", activate: true });
    await pressKeys(m, "Meta+j");
    expect(await agentOpen()).toBe(false);
    await pressKeys(m, "Meta+k");
    expect(await waitAgent(true)).toBe(true);
    await pressKeys(m, "Meta+k");
    expect(await waitAgent(false)).toBe(false);

    await click(m, '[data-testid="settings-button"]');
    await click(m, '[data-testid="settings-nav-shortcuts"]');
    await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="shortcut-agent-reset"]']);

    await edit("agent");
    await pressKeys(m, "Meta+c");
    await waitAlert("Réservé par macOS ou l'édition de texte");
    expect(await has('[data-testid="shortcut-agent-edit"]')).toBe(true); // the capture ended, binding unchanged
    expect(await text('[data-testid="shortcut-agent-key"]')).toBe("⌘K");

    await edit("agent");
    await pressKeys(m, "Meta+t");
    await waitAlert("Déjà utilisé par Barre de commande");
    expect(await text('[data-testid="shortcut-agent-key"]')).toBe("⌘K");

    await edit("agent");
    await pressKeys(m, "Escape");
    await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="shortcut-agent-edit"]']);
    expect(await text('[data-testid="shortcut-agent-key"]')).toBe("⌘K");

    await click(m, '[data-testid="shortcuts-reset-all"]');
    await waitUi(m, "return !doc.querySelector(arguments[0])", ['[data-testid="shortcut-agent-reset"]']);
    expect(await text('[data-testid="shortcut-agent-key"]')).toBe("⌘J");
  });

  it("shows the fixed shortcuts without a way to change them, and the vim switch off", async () => {
    const page = await text('[data-testid="settings-shortcuts"]');
    for (const keys of ["⌘1–9", "⌃1–9", "⌃Tab / ⌃⇧Tab"]) expect(page).toContain(keys);
    expect(await inUi<number>(m, "return doc.querySelectorAll('[data-testid^=\"shortcut-\"][data-testid$=\"-edit\"]').length")).toBe(17);
    expect(await inUi<boolean>(m, "return doc.querySelector('[data-testid=\"vim-mode\"]').checked")).toBe(false);
    await click(m, '[data-testid="vim-mode"]');
    expect((await state(m)).settings.vimMode).toBe(true);
  });

  it("every label of the interface follows a remapped shortcut", async () => {
    await edit("agent");
    await pressKeys(m, "Meta+k");
    await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="shortcut-agent-reset"]']);
    expect(await inUi<string>(m, "return doc.querySelector('[data-testid=\"agent-button\"]').title")).toBe("Agent (⌘K)");
  });

  async function waitAgent(open: boolean): Promise<boolean> {
    for (let i = 0; i < 50 && (await agentOpen()) !== open; i++) await new Promise((r) => setTimeout(r, 100));
    return agentOpen();
  }
});
