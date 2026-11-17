import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import { callTool } from "./mcp";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, waitUi, agentPanelReady } from "./ui";

// The agent's last tab: its activity from the host, and thumbnails taken only while someone watches.

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Chrome-context script body run with `v` = the store's agentView. */
const PILL = '[data-testid="agent-pill"]';
const view = <T>(m: Marionette, body: string) => m.execute<T>(`return (async () => { const v = (await ChromeUtils.importESModule("${STORE}").ready).agentView; ${body} })();`);
const VIEW_STATE = `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agentView.state())();`;

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
beforeAll(async () => {
  server = await startServer({ routes: { "/": (_, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<title>demo</title><h1 style='font-size:80px'>demo</h1>") } });
  // The demo port is the kernel's own: the agent's tabs there get every right, no consent card.
  w = await launchRessac({ env: { RESSAC_CONTAINER_PORTS: `${server.port}-${server.port}`, RESSAC_TEST_AGENT_VIEW: "1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".ressac", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await sleep(100)) if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  // The agent's session takes back every access when it starts: tools are called after it.
  await agentPanelReady(m);
}, 60_000);
afterAll(async () => {
  await w?.close();
  await server?.close();
});

describe("the agent's view", () => {
  it("follows the tab the agent reads, captures only while watched", async () => {
    const opened = await callTool(w.dataDir, "open_tab", { url: `${server.url}/` });
    expect(opened.error, opened.text).toBe(false);
    const tab = opened.text.trim();
    // A read takes a few ms: every state is recorded.
    await view(m, "window.agentViewStates = []; v.onState((s) => window.agentViewStates.push(s));");
    const read = await callTool(w.dataDir, "read_tab", { id: tab });
    expect(read.error, read.text).toBe(false);
    const states = await waitFor<any[]>(m, "return window.agentViewStates", (l) => l.some((s) => s?.running));
    expect(states.find((s) => s?.running)).toMatchObject({ tab, label: "Lit 127.0.0.1", site: "127.0.0.1", running: true });
    // The title follows the page once loaded.
    await waitFor<any>(m, VIEW_STATE, (s) => s?.title === "demo" && s.label === "Lit 127.0.0.1");

    // Nobody watches: no capture.
    await sleep(3_000);
    expect(await view(m, "return v.test.captures;")).toBe(0);

    await view(m, "window.agentViewFrames = []; window.agentViewStop = v.watch((f) => window.agentViewFrames.push(f));");
    const frames = await waitFor<(string | null)[]>(m, "return window.agentViewFrames", (l) => l.some((f) => !!f));
    const frame = frames.find((f) => !!f)!;
    expect(frame.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(frame.length).toBeGreaterThan(1000);
    // A tool running there: a capture every 700 ms, measured on several (not one first paint).
    const before = await view<number>(m, "return v.test.captures;");
    const slow = await callTool(w.dataDir, "run_js", { id: tab, code: "await new Promise((r) => setTimeout(r, 4000)); 1" });
    expect(slow.error, slow.text).toBe(false);
    await view(m, "window.agentViewStop();");
    // A capture in flight when the watcher left may still land.
    await sleep(200);
    const after = await view<number>(m, "return v.test.captures;");
    expect(after - before).toBeGreaterThanOrEqual(4);
    const ms = (await view<number[]>(m, "return v.test.ms;")).slice(before);
    const median = [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)]!;
    console.log(`[agent-view] ${ms.length} captures while a tool ran, median ${median.toFixed(1)} ms`);
    expect(median).toBeLessThan(30);
    // The watcher left: no capture after it.
    await sleep(1_500);
    expect(await view(m, "return v.test.captures;")).toBe(after);
  }, 60_000);

  it("shows a pill over the user's tab: open on the agent's tab, reducible, a click opens it, ✕ hides it, never on a recap", async () => {
    const opened = await callTool(w.dataDir, "open_tab", { url: `${server.url}/` });
    expect(opened.error, opened.text).toBe(false);
    const tab = opened.text.trim();
    const activeTab = async () => {
      const s = await state(m);
      const win = s.windows[0]!;
      return s.tabs[win.active[win.activeSpace]!];
    };
    const waitActive = async (id: string) => {
      for (const deadline = Date.now() + 10_000; (await activeTab())?.id !== id; await sleep(100)) if (Date.now() > deadline) throw new Error(`tab ${id} is not active`);
    };
    const pillShown = () => waitUi(m, `return doc.querySelector('${PILL}')?.textContent.includes("Lit 127.0.0.1")`, [], 10_000, "agentview");
    const pillGone = () => waitUi(m, `return !doc.querySelector('${PILL}')`, [], 5_000, "agentview");
    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${server.url}/?user` });
    const user = (await activeTab())!.id;
    expect(user).not.toBe(tab);

    expect((await callTool(w.dataDir, "read_tab", { id: tab })).error).toBe(false);
    await pillShown();
    expect(await inUi(m, `return doc.querySelector('${PILL}').getAttribute("aria-label")`, [], "agentview")).toBe("Voir l'onglet de l'agent");
    // It opens on a thumbnail of the agent's tab.
    await waitUi(m, `return doc.querySelector('[data-testid="agent-pill-frame"] img')?.src.startsWith("data:image/jpeg")`, [], 10_000, "agentview");
    await waitFor<number>(m, `return document.getElementById("ressac-agent-pill").clientWidth;`, (w) => w > 360, 5_000);

    // Reduced by hand, it is a line; the frame covers only the pill: the rest of the page keeps the mouse.
    await click(m, '[data-testid="agent-pill-toggle"]', { frame: "agentview" });
    await waitUi(m, `return !doc.querySelector('[data-testid="agent-pill-frame"]')`, [], 5_000, "agentview");
    const [width, height] = await waitFor<number[]>(m, `const f = document.getElementById("ressac-agent-pill"); return [f.clientWidth, f.clientHeight];`, ([w = 0, h = 0]) => w > 0 && w < 400 && h < 80, 5_000);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeLessThan(80);
    await click(m, '[data-testid="agent-pill-toggle"]', { frame: "agentview" });
    await waitFor<number>(m, `return document.getElementById("ressac-agent-pill").clientWidth;`, (w) => w > 360, 5_000);

    // A click opens the agent's tab, where the pill has no reason to be.
    await click(m, PILL, { frame: "agentview" });
    await waitActive(tab);
    await pillGone();

    // Never over a recap page. A new read keeps the agent's tab within its 20 s hold.
    await dispatch(m, { type: "activateTab", id: user });
    expect((await callTool(w.dataDir, "read_tab", { id: tab })).error).toBe(false);
    await pillShown();
    const recap = await callTool(w.dataDir, "show_recap", { title: "Pastille", results: { items: [{ name: "A" }] }, plan: { blocks: [{ component: "cards", props: { items: "items", title: "name" } }] } });
    expect(recap.text, recap.text).toMatch(/Récap \S+ ouvert/);
    for (const deadline = Date.now() + 10_000; !(await activeTab())?.url.startsWith("ressac://recap/"); await sleep(100)) if (Date.now() > deadline) throw new Error("the recap tab is not active");
    await pillGone();

    // ✕ hides it, and it stays hidden while the agent's tab is held.
    await dispatch(m, { type: "activateTab", id: user });
    await pillShown();
    await click(m, '[data-testid="agent-pill-close"]', { frame: "agentview" });
    await pillGone();
    await sleep(1_000);
    expect(await inUi(m, `return !!doc.querySelector('${PILL}')`, [], "agentview")).toBe(false);
    expect(await m.execute<number>(`return document.getElementById("ressac-agent-pill").clientWidth;`)).toBe(0);
  }, 90_000);
});
