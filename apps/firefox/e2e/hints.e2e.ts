import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TIPS } from "../shared/hints";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, pressKeys, waitUi, type Frame } from "./ui";

// Plan 47 Tasks 3-4: the « Astuce » card on the empty page; using a shortcut retires its tip; the Settings switch; the one-time notes (agent, actions).

const CARD = '[data-testid="tip-card"]';
let w: LaunchedWebAiOs;
let m: Marionette;
beforeEach(async () => {
  w = await launchWebAiOs({ env: { WEBAIOS_OLLAMA_URL: "http://127.0.0.1:9" }, firstTimeNotes: true });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
});
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
  }
});

const cardShows = (text: string) => waitUi(m, "return doc.querySelector(arguments[0])?.textContent.includes(arguments[1])", [CARD, text]);
const noCard = () => waitUi(m, "return !doc.querySelector(arguments[0])", [CARD]);
const press = (id: string) => click(m, `${CARD} [data-testid="${id}"]`);
const seen = (): string[] => {
  try {
    return JSON.parse(readFileSync(join(w.dataDir, "session.json"), "utf8")).settings?.hints?.seen ?? [];
  } catch {
    return [];
  }
};
const savedSeen = (want: string[]) => waitFor(m, "return true", () => JSON.stringify(seen()) === JSON.stringify(want), 15_000);

describe("hints", () => {
  it("first tip", async () => {
    await cardShows("⌃Tab");
  });

  it("close and next", async () => {
    await cardShows("⌃Tab");
    await press("tip-close");
    await cardShows("⌘T");
    await press("tip-next");
    await cardShows("⌘L");
    await savedSeen(["ctrl-tab", "cmd-t"]);
  });

  it("gesture marks it", async () => {
    await cardShows("⌃Tab");
    await press("tip-close");
    await cardShows("⌘T");
    await pressKeys(m, "Meta+t");
    await pressKeys(m, "Escape");
    await savedSeen(["ctrl-tab", "cmd-t"]);
    await cardShows("⌘L");
  });

  it("try it", async () => {
    await cardShows("⌃Tab");
    await press("tip-close");
    await cardShows("⌘T");
    await press("tip-try");
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"command-bar\"]') || !!doc.querySelector('[data-testid=\"command-input\"]')");
  });

  it("all seen", async () => {
    for (const t of TIPS) await dispatch(m, { type: "markHintSeen", id: t.id });
    await noCard();
  });

  it("switch off", async () => {
    await cardShows("⌃Tab");
    // Flips the Settings switch, then closes the Settings tab to come back to the empty page.
    const flip = async () => {
      await click(m, '[data-testid="settings-button"]');
      await click(m, '[data-testid="settings-nav-privacy"]');
      await click(m, '[data-testid="settings-hints"]');
      const tab = Object.values((await state(m)).tabs).find((t) => t.url === "webaios://settings")!;
      await dispatch(m, { type: "closeTab", id: tab.id });
    };
    await flip();
    await noCard();
    expect((await state(m)).settings.hints.enabled).toBe(false);
    await flip();
    await cardShows("⌃Tab");
  });
});

const noteIn = (id: string, frame: Frame) => waitUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="first-time-${id}"]`], 10_000, frame);
const noNoteIn = (id: string, frame: Frame) => waitUi(m, "return !doc.querySelector(arguments[0])", [`[data-testid="first-time-${id}"]`], 10_000, frame);

describe("first-time notes", () => {
  it("agent first time", async () => {
    // The panel is open by default on the home page.
    await noteIn("agent", "agent");
    expect(await inUi<string>(m, 'return doc.querySelector(\'[data-testid="first-time-agent"] h2\').textContent;', [], "agent")).toBe("L'agent");
    await click(m, '[data-testid="first-time-ok"]', { frame: "agent" });
    await noNoteIn("agent", "agent");
    await savedSeen(["agent"]);
    // Closed, opened again: no note.
    await click(m, '[data-testid="agent-button"]');
    await click(m, '[data-testid="agent-button"]');
    await noNoteIn("agent", "agent");
  });

  it("Escape is Compris", async () => {
    await noteIn("agent", "agent");
    // The key goes to the agent frame itself: which frame has the keyboard in a headless window is not what is tested.
    await inUi(m, "doc.defaultView.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));", [], "agent");
    await noNoteIn("agent", "agent");
    await savedSeen(["agent"]);
  });

  it("actions first time", async () => {
    await click(m, '[data-testid="actions-button"]');
    await noteIn("actions", "sidebar");
    await click(m, '[data-testid="first-time-ok"]');
    await noNoteIn("actions", "sidebar");
    await waitFor(m, "return true", () => seen().includes("actions"), 15_000);
    await click(m, '[data-testid="actions-button"]');
    await click(m, '[data-testid="actions-button"]');
    await noNoteIn("actions", "sidebar");
  });

  it("switch off", async () => {
    await dispatch(m, { type: "setHintsEnabled", enabled: false });
    await noNoteIn("agent", "agent");
    await click(m, '[data-testid="actions-button"]');
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"page-actions\"]')");
    await noNoteIn("actions", "sidebar");
  });
});
