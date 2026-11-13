import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import { callTool } from "./mcp";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { waitUi } from "./ui";

// The agent's last tab: its activity from the host, and thumbnails taken only while someone watches.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Chrome-context script body run with `v` = the store's agentView. */
const view = <T>(m: Marionette, body: string) => m.execute<T>(`return (async () => { const v = (await ChromeUtils.importESModule("${STORE}").ready).agentView; ${body} })();`);

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => {
  server = await startServer({ routes: { "/": (_, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<title>demo</title><h1 style='font-size:80px'>demo</h1>") } });
  // The demo port is the kernel's own: the agent's tabs there get every right, no consent card.
  w = await launchWebAiOs({ env: { WEBAIOS_CONTAINER_PORTS: `${server.port}-${server.port}`, WEBAIOS_TEST_AGENT_VIEW: "1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await sleep(100)) if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  // The agent's session takes back every access when it starts: tools are called after it.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
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
    expect(states.find((s) => s?.running)).toMatchObject({ tab, label: "Lit 127.0.0.1", site: "127.0.0.1", title: "demo", running: true });
    expect(await view(m, "return v.state();")).toMatchObject({ tab, label: "Lit 127.0.0.1" });

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
});
