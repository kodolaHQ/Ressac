import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentInput } from "./apps";
import { tid, uiQueries } from "./actions";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startEmbedServer, startServer } from "./server";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// The ⌘T bar's Demander mode: a fake search model (one vector per concept, French and English alike) and the fake
// agent, history seeded through the host and given its vectors by the host's indexer.

const STORE = "chrome://browser/content/ressac/store.sys.mjs";

let server: Awaited<ReturnType<typeof startServer>>;
let embed: Awaited<ReturnType<typeof startEmbedServer>>;
let w: LaunchedRessac;
let m: Marionette;
let q: ReturnType<typeof uiQueries>;

beforeAll(async () => {
  server = await startServer();
  // « Page A » is the title of /a.html loaded for real, its kept text may replace the seeded one.
  embed = await startEmbedServer([["mascaret", "tidal bore"], ["garonne", "page a"]]);
});
afterAll(async () => {
  await server?.close();
  await embed?.close();
});
beforeEach(async () => {
  embed.inputs.length = 0;
  embed.refuse = false;
  w = await launchRessac({
    env: { RESSAC_OLLAMA_URL: "http://127.0.0.1:9", RESSAC_EMBED_SERVER_URL: embed.url, RESSAC_TEST_INDEX_IDLE_MS: "100", RESSAC_MEMORY_LOOP: "1" },
  });
  m = w.marionette;
  q = uiQueries(m);
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
});
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
  }
});

const win = async () => (await state(m)).windows[0]!;
const fieldFocused = () =>
  waitUi(m, "return doc.activeElement?.dataset.testid === 'command-input' && document.activeElement === document.getElementById('ressac-sidebar')");
async function type(text: string): Promise<void> {
  await fieldFocused();
  await inUi(m, `const f = doc.activeElement; f.value = arguments[0]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [text]);
}
const fieldValue = () => q.value(tid("command-input"));
/** The pill's current mode, as shown. */
const modeShown = () => inUi<string | null>(m, "return doc.querySelector(arguments[0])?.textContent.trim() ?? null;", [`${tid("command-mode")} [aria-current="true"]`]);
const waitMode = (label: string) => waitUi(m, "return doc.querySelector(arguments[0])?.textContent.trim() === arguments[1];", [`${tid("command-mode")} [aria-current="true"]`, label]);
const waitBar = (open: boolean) => waitUi(m, "return !!doc.querySelector('[data-testid=\"command-bar\"]') === arguments[0]", [open]);
async function openTab(path: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const after = await dispatch(m, { type: "openTab", windowId: (await win()).id, url: server.url + path });
  return Object.keys(after.tabs).find((id) => !before.has(id))!;
}
/** A visit of the active space with kept text, written straight into the host's history, once the indexer embedded it. */
async function seed(path: string, title: string, text: string): Promise<string> {
  const f = await win();
  const url = server.url + path;
  await m.execute(
    `return (async () => { const h = (await ChromeUtils.importESModule("${STORE}").ready).agent;
      h.notify("history.record", { url: arguments[0], title: arguments[1], spaceId: arguments[2], private: false });
      h.notify("history.keep", { url: arguments[0], title: arguments[1], spaceId: arguments[2], text: arguments[3] });
      await h.request("history.recent", {}); })();`,
    [url, title, f.activeSpace, text],
  );
  await expect.poll(() => embed.inputs.some((t) => t.startsWith(`title: ${title} | text: 127.0.0.1 ${text.slice(0, 20)}`)), { timeout: 20_000 }).toBe(true);
  return url;
}
/** ⌘T, Demander, the question typed. */
async function ask(question: string): Promise<void> {
  await pressKeys(m, "Meta+t");
  await fieldFocused();
  await pressKeys(m, "Tab");
  await waitMode("Demander");
  await type(question);
}
const agentPanelShown = () => waitFor(m, "return !document.getElementById('ressac-agent').hidden", (v) => v === true);
const received = (text: string) => expect.poll(() => agentInput(w.dataDir), { timeout: 20_000 }).toContain(`${text}\r`);

describe("the ⌘T bar's Chercher / Demander switch", () => {
  it("⇥ switches to Demander and back, the text kept; each ⌘T opens in Chercher", async () => {
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    expect(await modeShown()).toBe("Chercher");
    await type("mascarets");
    await pressKeys(m, "Tab");
    await waitMode("Demander");
    await fieldFocused();
    expect(await fieldValue()).toBe("mascarets");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).placeholder", [tid("command-input")])).toBe("Posez une question");
    // The Chercher rows fade out (150 ms) before they go.
    await q.waitCount(tid("command-row"), 0);
    await pressKeys(m, "Tab");
    await waitMode("Chercher");
    expect(await fieldValue()).toBe("mascarets");
    // The pill switches with a click too.
    await click(m, tid("command-mode-ask"));
    await waitMode("Demander");
    await fieldFocused();
    // Reopened: Chercher again.
    await pressKeys(m, "Escape");
    await waitBar(false);
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    expect(await modeShown()).toBe("Chercher");
  });

  it("a page answer: an English page for a French question, « Demander à l'agent » last, Enter opens the first in a new tab", async () => {
    const url = await seed("/b.html", "The tidal bore of the Seine", "The tidal bore runs up the Seine at each spring tide.");
    const tabsBefore = Object.keys((await state(m)).tabs).length;
    await ask("c'était quoi la page sur les mascarets");
    expect(await q.count(tid("command-ask-hit"))).toBe(0);
    await pressKeys(m, "Enter");
    await q.waitCount(tid("command-ask-hit"), 1);
    await q.waitCount(tid("command-ask-agent"), 1);
    await q.waitContains(tid("command-ask-hit"), "The tidal bore of the Seine");
    await q.waitContains(tid("command-ask-hit"), "aujourd'hui");
    // The kept text's excerpt, not the address.
    await q.waitContains(tid("command-ask-hit"), "runs up the Seine");
    await q.waitContains(tid("command-ask-agent"), "Demander à l'agent");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).getAttribute('aria-selected')", [tid("command-ask-hit")])).toBe("true");
    expect(embed.inputs).toContain("task: search result | query: c'était quoi la page sur les mascarets");
    await pressKeys(m, "Enter");
    await waitBar(false);
    const s = await state(m);
    expect(Object.keys(s.tabs)).toHaveLength(tabsBefore + 1);
    const f = s.windows[0]!;
    expect(s.tabs[f.active[f.activeSpace]!]?.url).toBe(url);
  });

  it("a page answer whose hit is open in the window: Enter switches to that tab", async () => {
    const a = await openTab("/a.html");
    await waitFor(m, "return gBrowser.selectedBrowser.contentTitle", (v) => v === "Page A");
    await openTab("/b.html");
    await waitFor(m, "return gBrowser.selectedBrowser.contentTitle", (v) => v === "Page B");
    // Matched by its address: the page it shows may already have its own text kept.
    await seed("/a.html", "Page A", "Une barre de marée sur la Garonne.");
    const tabsBefore = Object.keys((await state(m)).tabs).length;
    await ask("la page sur la Garonne");
    await pressKeys(m, "Enter");
    await q.waitCount(tid("command-ask-hit"), 1);
    await pressKeys(m, "Enter");
    await waitBar(false);
    const s = await state(m);
    expect(Object.keys(s.tabs)).toHaveLength(tabsBefore);
    const f = s.windows[0]!;
    expect(f.active[f.activeSpace]).toBe(a);
  });

  it("a hit open in another space of the window: Enter switches to that space and tab", async () => {
    const first = (await win()).activeSpace;
    const a = await openTab("/a.html");
    await waitFor(m, "return gBrowser.selectedBrowser.contentTitle", (v) => v === "Page A");
    await dispatch(m, { type: "createSpace", name: "Pro", icon: "💼", private: false, profile: "default", windowId: (await win()).id });
    await seed("/a.html", "Page A", "Une barre de marée sur la Garonne.");
    const tabsBefore = Object.keys((await state(m)).tabs).length;
    await ask("la page sur la Garonne");
    await pressKeys(m, "Enter");
    await q.waitCount(tid("command-ask-hit"), 1);
    await pressKeys(m, "Enter");
    await waitBar(false);
    const s = await state(m);
    expect(Object.keys(s.tabs)).toHaveLength(tabsBefore);
    const f = s.windows[0]!;
    expect(f.activeSpace).toBe(first);
    expect(f.active[first]).toBe(a);
  });

  it("an action request: the agent panel opens and gets exactly the question, nothing embedded", async () => {
    await ask("écris-moi un poème sur la mer");
    await pressKeys(m, "Enter");
    await waitBar(false);
    await agentPanelShown();
    await received("écris-moi un poème sur la mer");
    expect(agentInput(w.dataDir)).not.toContain("—");
    expect(embed.inputs.filter((t) => t.includes("poème"))).toEqual([]);
  });

  it("an action request holding a phone reaches the agent with its label, never the number", async () => {
    const phone = "06 12 34 " + "56 78";
    await ask(`écris un message au ${phone} pour dire bonjour`);
    await pressKeys(m, "Enter");
    await waitBar(false);
    await agentPanelShown();
    await expect.poll(() => agentInput(w.dataDir), { timeout: 20_000 }).toMatch(/écris un message au ⟨tel-[a-z0-9]{8}⟩ pour dire bonjour\r/);
    expect(agentInput(w.dataDir)).not.toContain(phone);
    expect(agentInput(w.dataDir)).not.toContain(phone.replaceAll(" ", ""));
  });

  it("« Demander à l'agent » after the hits: one line with the question and the hits' URLs", async () => {
    const url = await seed("/b.html", "Le mascaret de la Seine", "Le mascaret remonte la Seine.");
    await ask("la page sur les mascarets");
    await pressKeys(m, "Enter");
    await q.waitCount(tid("command-ask-agent"), 1);
    // ↑ from the first hit wraps to the last line.
    await pressKeys(m, "ArrowUp");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).getAttribute('aria-selected')", [tid("command-ask-agent")])).toBe("true");
    await pressKeys(m, "Enter");
    await waitBar(false);
    await agentPanelShown();
    await expect.poll(() => agentInput(w.dataDir), { timeout: 20_000 }).toMatch(/\r/);
    const line = agentInput(w.dataDir).split("\r")[0]!;
    expect(line.startsWith("la page sur les mascarets — ")).toBe(true);
    expect(line).toContain(JSON.stringify(url));
    expect(line).not.toContain("\n");
  });

  it("the search model failing: Enter goes to the agent", async () => {
    embed.refuse = true;
    await ask("où est la page des marées");
    await pressKeys(m, "Enter");
    await waitBar(false);
    await agentPanelShown();
    await received("où est la page des marées");
    expect(embed.inputs).toContain("task: search result | query: où est la page des marées");
  });

  it("typing after the hits clears them", async () => {
    await seed("/b.html", "Le mascaret de la Seine", "Le mascaret remonte la Seine.");
    await ask("les mascarets");
    await pressKeys(m, "Enter");
    await q.waitCount(tid("command-ask-hit"), 1);
    await type("les mascarets de la Seine");
    await q.waitCount(tid("command-ask-hit"), 0);
    await q.waitCount(tid("command-ask-agent"), 0);
    expect(await q.count(tid("command-bar"))).toBe(1);
  });
});
