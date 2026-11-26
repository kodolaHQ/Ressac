import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { OwnEngine } from "../shared/settings";
import { callMcpTool } from "../test/mcp";
import { state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, pressKeys, typeText, waitUi } from "./ui";

// The sidebar's « Agent » section by discussion: two discussions on « Votre modèle » (a loop in the host, so its open_tab
// really opens a tab) each open a page; the fake Ollama answers each loop step with the test's next scripted action.
const MODEL = "qwen-test:4b";
const OWN = '[data-testid="own-engine"]';
let script: (() => object)[] = [];

const body = (req: IncomingMessage): Promise<any> =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s ? JSON.parse(s) : null));
  });
const json = (res: ServerResponse, o: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(o));
const page = (title: string) => (_req: IncomingMessage, res: ServerResponse) => void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<title>${title}</title><p>${title}</p>`);
let model: Awaited<ReturnType<typeof startServer>>;
let site: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  model = await startServer({
    routes: {
      "/api/tags": (req, res) => void body(req).then(() => json(res, { models: [{ name: MODEL, details: { parameter_size: "4B" } }] })),
      "/api/show": (req, res) => void body(req).then(() => json(res, { details: {} })),
      "/api/chat": (req, res) => void body(req).then(() => json(res, { message: { content: JSON.stringify(script.shift()?.() ?? { action: "answer", text: "Fin du script." }) }, prompt_eval_count: 200 })),
    },
  });
  site = await startServer({ routes: { "/un": page("Page un"), "/deux": page("Page deux") } });
});
afterAll(async () => {
  await Promise.all([model?.close(), site?.close()]);
});

let w: LaunchedRessac | undefined;
let m: Marionette;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const waitAgent = <T>(js: string, args: unknown[] = [], ms = 20_000) => waitUi<T>(m, js, args, ms, "agent");
const savedOwn = (): OwnEngine | undefined => {
  try {
    return JSON.parse(readFileSync(join(w!.dataDir, "session.json"), "utf8")).settings?.ownEngine;
  } catch {
    return undefined;
  }
};
const fill = (id: string, value: string) =>
  inUi(m, "const f = doc.querySelector(arguments[0]); f.value = arguments[1]; f.dispatchEvent(new ui.Event('input', { bubbles: true })); f.dispatchEvent(new ui.Event('change', { bubbles: true }));", [`${OWN} [data-testid="${id}"]`, value]);

/** Réglages › Agent › Votre modèle on the fake Ollama. */
async function ownOnFake(): Promise<void> {
  await click(m, '[data-testid="settings-button"]');
  await click(m, '[data-testid="settings-nav-agent"]');
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [OWN]);
  await fill("ollama-url", model.url);
  await waitFor(m, "return true", () => savedOwn()?.ollamaUrl === model.url, 15_000);
  await waitUi(m, "const s = doc.querySelector(arguments[0]); return s?.tagName === 'SELECT' && [...s.options].some((o) => o.value === arguments[1])", [`${OWN} [data-testid="ollama-model"]`, MODEL]);
  await fill("ollama-model", MODEL);
  await waitFor(m, "return true", () => savedOwn()?.ollamaModel === MODEL, 15_000);
}
/** A new discussion on « Votre modèle », from the chip's menu. */
async function ownDiscussion(): Promise<void> {
  await waitAgent("return !!doc.querySelector('[data-testid=\"chat-mode-chip\"]')");
  await click(m, '[data-testid="chat-mode-chip"]', { frame: "agent" });
  await click(m, '[data-testid="chat-profile-own"]', { frame: "agent" });
  await waitAgent("return doc.querySelector('[data-testid=\"chat-mode-chip\"]')?.textContent.includes('Votre modèle') && !doc.querySelector('[data-testid=\"chat-user\"]') && !!doc.querySelector('[data-testid=\"chat-input\"]')");
}
async function send(text: string): Promise<void> {
  await click(m, '[data-testid="chat-input"]', { frame: "agent" });
  await waitAgent("return doc.activeElement?.dataset.testid === 'chat-input'");
  await typeText(m, text);
  await pressKeys(m, "Enter");
  await waitAgent("return doc.querySelector('[data-testid=\"chat-input\"]')?.value === ''");
}
const agentSays = (text: string) => waitAgent("return [...doc.querySelectorAll('[data-testid=\"chat-agent\"]')].some((e) => e.textContent.includes(arguments[0]))", [text], 60_000);
/** The sidebar's groups as shown: title, count, unfolded, marked as the panel's, and the titles of the tabs listed under it. */
type Group = { title: string; count: string; open: boolean; current: boolean; tabs: string[] };
const groups = () =>
  inUi<Group[]>(
    m,
    `return [...doc.querySelectorAll('[data-testid="agent-group"]')].map((g) => {
       const list = g.nextElementSibling?.matches("ul.tabs") ? g.nextElementSibling : null;
       return { title: g.querySelector(".label").textContent, count: g.querySelector(".count").textContent, open: g.querySelector('[data-testid="agent-group-fold"]').getAttribute("aria-expanded") === "true", current: g.classList.contains("current"), tabs: list ? [...list.querySelectorAll(".title")].map((t) => t.textContent) : [] };
     })`,
  );
const groupsAre = async (wanted: Group[]) => expect.poll(groups, { timeout: 20_000 }).toEqual(wanted);
const activeTitle = async () => {
  const s = await state(m);
  const f = s.windows[0]!;
  return s.tabs[f.active[f.activeSpace] ?? ""]?.title;
};

it("les onglets de l'agent se rangent par discussion : celle du panneau dépliée, un clic sur le titre l'ouvre, supprimée elle passe dans « Sans discussion »", { timeout: 180_000 }, async () => {
  w = await launchRessac({ agentView: "chat", writer: "claude" });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await ownOnFake();
  await click(m, '[data-testid="agent-button"]');
  // The window's first discussion (Claude's) has started: its session start takes back the window's accesses, so it
  // must not land during the own discussions' turns.
  await expect.poll(() => existsSync(join(w!.dataDir, "workspace", "fake-chat-claude.jsonl")) && readFileSync(join(w!.dataDir, "workspace", "fake-chat-claude.jsonl"), "utf8").includes('"argv"'), { timeout: 30_000 }).toBe(true);

  await ownDiscussion();
  script = [() => ({ action: "open_tab", url: `${site.url}/un` }), () => ({ action: "answer", text: "Ouvert un." })];
  await send("un");
  await agentSays("Ouvert un.");
  await ownDiscussion();
  script = [() => ({ action: "open_tab", url: `${site.url}/deux` }), () => ({ action: "answer", text: "Ouvert deux." })];
  await send("deux");
  await agentSays("Ouvert deux.");

  // The panel's discussion first, unfolded and marked; the other folded.
  await groupsAre([
    { title: "deux", count: "1", open: true, current: true, tabs: ["Page deux"] },
    { title: "un", count: "1", open: false, current: false, tabs: [] },
  ]);

  // Unfolded by hand, « un » stays open next to « deux ».
  await click(m, '[data-testid="agent-group-fold"][aria-expanded="false"]');
  await groupsAre([
    { title: "deux", count: "1", open: true, current: true, tabs: ["Page deux"] },
    { title: "un", count: "1", open: true, current: false, tabs: ["Page un"] },
  ]);

  // Its title opens « un » in the panel: that group unfolds, « deux » folds.
  await click(m, '[data-testid="agent-group-title"]', { text: "un" });
  await waitAgent("return [...doc.querySelectorAll('[data-testid=\"chat-user\"]')].map((e) => e.textContent).join() === 'un'");
  await groupsAre([
    { title: "un", count: "1", open: true, current: true, tabs: ["Page un"] },
    { title: "deux", count: "1", open: false, current: false, tabs: [] },
  ]);

  // The thread's open_tab line shows its tab (Réglages on screen meanwhile).
  await click(m, '[data-testid="settings-button"]');
  await expect.poll(activeTitle, { timeout: 10_000 }).not.toBe("Page un");
  await click(m, 'button[data-testid="chat-tool"]', { frame: "agent" });
  await expect.poll(activeTitle, { timeout: 10_000 }).toBe("Page un");

  // « deux » deleted: its tab stays open, under « Sans discussion », folded.
  await click(m, '[data-testid="chat-picker"]', { frame: "agent" });
  await click(m, '[data-testid="chat-row-delete"][aria-label*="deux"]', { frame: "agent" });
  await click(m, '[data-testid="chat-delete-confirm"]', { frame: "agent" });
  await groupsAre([
    { title: "un", count: "1", open: true, current: true, tabs: ["Page un"] },
    { title: "Sans discussion", count: "1", open: false, current: false, tabs: [] },
  ]);
  expect(Object.values((await state(m)).tabs).some((t) => t.title === "Page deux")).toBe(true);
});

it("un récap montré par une discussion se range dans le groupe de cette discussion", { timeout: 120_000 }, async () => {
  w = await launchRessac({ agentView: "chat", writer: "claude" });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await click(m, '[data-testid="agent-button"]');
  const log = join(w.dataDir, "workspace", "fake-chat-claude.jsonl");
  await expect.poll(() => existsSync(log) && readFileSync(log, "utf8").includes('"argv"'), { timeout: 30_000 }).toBe(true);
  // The call as the discussion's agent makes it: with its session's token (`.ressac/sessions/<id>.json`).
  const folder = join(w.dataDir, "workspace", ".ressac", "sessions");
  const config = readdirSync(folder).find((f) => f.endsWith(".json"))!;
  const plan = { blocks: [{ component: "highlight", props: { object: "best", label: "Le plus haut", title: "name", value: "height" } }] };
  const results = { best: { name: "Mont Blanc", height: "4 806 m" } };
  const r = await callMcpTool(join(w.dataDir, "workspace"), "show_recap", { title: "Sommets", results, plan }, join(folder, config));
  expect(r.text).toMatch(/Récap \S+ ouvert/);
  await expect
    .poll(async () => (await groups()).find((g) => g.tabs.includes("Sommets")), { timeout: 20_000 })
    .toMatchObject({ open: true, current: true, count: "1" });
  expect((await groups()).some((g) => g.title === "Sans discussion")).toBe(false);
});
