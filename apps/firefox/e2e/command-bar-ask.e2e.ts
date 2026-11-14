import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentInput } from "./apps";
import { listen, tid, uiQueries, type TestServer } from "./actions";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// The ⌘T bar's Demander mode: a fake Ollama (its Gemma answer canned per test) and the fake agent, history seeded through the host.

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const GEMMA_TAGS = '{"models":[{"name":"gemma4:e4b"}]}';

let server: Awaited<ReturnType<typeof startServer>>;
let ollama: TestServer;
let kev: TestServer;
let tags = GEMMA_TAGS;
let answer: unknown = { kind: "other" };
/** Bodies of the /api/chat requests. */
const chats: string[] = [];
let w: LaunchedRessac;
let m: Marionette;
let q: ReturnType<typeof uiQueries>;

beforeAll(async () => {
  server = await startServer();
  ollama = await listen((req, res, body) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/tags") return res.end(tags);
    if (req.url === "/api/chat") {
      chats.push(body);
      return res.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }));
    }
    res.end("{}");
  });
  kev = await listen((_req, res) => void res.writeHead(200, { "Content-Type": "application/json" }).end('{"data":[]}'));
});
afterAll(async () => {
  await server?.close();
  await ollama?.close();
  await kev?.close();
});
beforeEach(async () => {
  tags = GEMMA_TAGS;
  answer = { kind: "other" };
  chats.length = 0;
  w = await launchRessac({ env: { RESSAC_OLLAMA_URL: ollama.url, RESSAC_KEV_URL: kev.url, RESSAC_MEMORY_LOOP: "1" } });
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
/** A visit of the active space with kept text, written straight into the host's history. */
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

  it("a page answer: the hits and « Demander à l'agent », Enter opens the first in a new tab", async () => {
    const url = await seed("/b.html", "Le mascaret de la Seine", "Le mascaret remonte la Seine à chaque grande marée.");
    answer = { kind: "page", terms: ["mascaret"] };
    const tabsBefore = Object.keys((await state(m)).tabs).length;
    await ask("c'était quoi la page sur les mascarets");
    expect(await q.count(tid("command-ask-hit"))).toBe(0);
    await pressKeys(m, "Enter");
    await q.waitCount(tid("command-ask-hit"), 1);
    await q.waitCount(tid("command-ask-agent"), 1);
    await q.waitContains(tid("command-ask-hit"), "Le mascaret de la Seine");
    await q.waitContains(tid("command-ask-hit"), "aujourd'hui");
    // The kept text's excerpt, not the address.
    await q.waitContains(tid("command-ask-hit"), "remonte la Seine");
    await q.waitContains(tid("command-ask-agent"), "Demander à l'agent");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).getAttribute('aria-selected')", [tid("command-ask-hit")])).toBe("true");
    expect(chats.some((c) => c.includes("c'était quoi la page sur les mascarets"))).toBe(true);
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
    answer = { kind: "page", terms: ["a.html"] };
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
    answer = { kind: "page", terms: ["a.html"] };
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

  it("an « other » answer: the agent panel opens and gets exactly the question", async () => {
    answer = { kind: "other" };
    await ask("écris-moi un poème sur la mer");
    await pressKeys(m, "Enter");
    await waitBar(false);
    await agentPanelShown();
    await received("écris-moi un poème sur la mer");
    expect(agentInput(w.dataDir)).not.toContain("—");
  });

  it("« Demander à l'agent » after the hits: one line with the question and the hits' URLs", async () => {
    const url = await seed("/b.html", "Le mascaret de la Seine", "Le mascaret remonte la Seine.");
    answer = { kind: "page", terms: ["mascaret"] };
    await ask("la vidéo sur les mascarets");
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
    expect(line.startsWith("la vidéo sur les mascarets — ")).toBe(true);
    expect(line).toContain(JSON.stringify(url));
    expect(line).not.toContain("\n");
  });

  it("no Gemma in Ollama: Enter goes straight to the agent, Gemma never asked", async () => {
    tags = '{"models":[]}';
    await ask("où est la page des marées");
    await pressKeys(m, "Enter");
    await waitBar(false);
    await agentPanelShown();
    await received("où est la page des marées");
    expect(chats.filter((c) => c.includes("où est la page des marées"))).toEqual([]);
  });

  it("typing after the hits clears them", async () => {
    await seed("/b.html", "Le mascaret de la Seine", "Le mascaret remonte la Seine.");
    answer = { kind: "page", terms: ["mascaret"] };
    await ask("les mascarets");
    await pressKeys(m, "Enter");
    await q.waitCount(tid("command-ask-hit"), 1);
    await type("les mascarets de la Seine");
    await q.waitCount(tid("command-ask-hit"), 0);
    await q.waitCount(tid("command-ask-agent"), 0);
    expect(await q.count(tid("command-bar"))).toBe(1);
  });
});
