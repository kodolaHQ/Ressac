import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { NO_WORKFLOW_OPEN, navigationOutsideSite } from "../../../packages/kernel/src/index";
import { PRIVATE_TEXT } from "../../../packages/kernel/src/mcp/bridge";
import { hostPath, nodePath, tsxPath } from "../scripts/paths";
import { createRpc, type Handler, type Rpc } from "../shared/rpc";
import { callMcpTool } from "./mcp";

const tools = join(import.meta.dirname, "tools");
const tabs = [
  { id: "t1", title: "Un", url: "https://un.test/", space: "Perso" },
  { id: "t2", title: "Deux", url: "https://deux.test/", space: "Perso" },
];
// 2 KB: a PNG signature followed by filler, enough to check the bytes go through unchanged.
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2040, 7)]).toString("base64");

interface Host {
  child: ChildProcessWithoutNullStreams;
  rpc: Rpc;
  dataDir: string;
  root: string;
  log: string;
  stderr: () => string;
  data: () => string;
  states: unknown[];
  exited: Promise<number | null>;
}

const hosts: Host[] = [];

/**
 * `o.dataDir`: restart on that folder; `o.handlers`: more requests answered as Firefox. Like the chrome, it pushes an empty
 * passport set at once (no tool answers before), unless `o.passport` is false.
 */
function startHost(env: Record<string, string> = {}, prepare?: (dataDir: string) => void, o: { dataDir?: string; handlers?: Record<string, Handler>; passport?: false } = {}): Host {
  const dataDir = o.dataDir ?? realpathSync(mkdtempSync(join(tmpdir(), "ressac-host-")));
  prepare?.(dataDir);
  const root = join(dataDir, "workspace");
  const log = join(dataDir, "docker.log");
  const { RESSAC_CONTAINER: _, RESSAC_CONTAINER_PORTS: __, ...parent } = process.env;
  const child = spawn(nodePath, ["--import", tsxPath, hostPath], {
    env: {
      ...parent,
      RESSAC_DATA_DIR: dataDir,
      // The fake docker and fake agent write their traces there.
      RESSAC_ROOT: root,
      FAKE_DOCKER_LOG: log,
      RESSAC_HOST_TEST: "1",
      // The host must not start the machine's real container app.
      RESSAC_TEST_NO_SYSTEM: "1",
      PATH: `${tools}:${process.env.PATH}`,
      // A free port: never the real 5279.
      RESSAC_PORT_MCP_EXTERNAL: "0",
      // AI on downloads Ressac's models: never from the real web here (a closed local port fails at once).
      RESSAC_D1_URL: "http://127.0.0.1:9/d1.gguf",
      RESSAC_EMBED_URL: "http://127.0.0.1:9/embed.gguf",
      ...env,
    },
  });
  let err = "";
  let data = "";
  const states: unknown[] = [];
  child.stderr.on("data", (d) => (err += d));
  const rpc = createRpc({
    send: (l) => child.stdin.write(l + "\n"),
    handlers: {
      activeTab: () => tabs[0],
      listTabs: () => tabs,
      readText: ([id]: [string]) => ({ text: `texte de ${id}` }),
      capture: () => png,
      // The carrier check's read: without it every capture is refused (fail closed).
      carrierText: () => ({ documents: [], unread: false }),
      askPermission: () => true,
      "agent.data": (p: { data: string }) => void (data += p.data),
      "agent.state": (p: { state: unknown }) => void states.push(p.state),
      ...o.handlers,
    },
  });
  createInterface({ input: child.stdout }).on("line", (l) => rpc.receive(l));
  if (o.passport !== false) void rpc.request("passport.ready", { unreadable: [] }).catch(() => {});
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => (rpc.close(`host exited: ${err}`), r(code))));
  const h = { child, rpc, dataDir, root: root, log: log, stderr: () => err, data: () => data, states: states, exited };
  hosts.push(h);
  return h;
}

async function until(f: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(async () => {
  for (const h of hosts.splice(0)) {
    if (h.child.exitCode === null) {
      h.child.kill("SIGKILL");
      await h.exited;
    }
    // A fake app left running would hold its test port.
    for (const f of existsSync(h.root) ? readdirSync(h.root) : [])
      if (/^fake-docker-app-.*\.pid$/.test(f))
        try {
          process.kill(-Number(readFileSync(join(h.root, f), "utf8")), "SIGKILL");
        } catch {
          // already stopped
        }
    // Detached fake docker calls started before the host exited can still append to the journal for a moment.
    const rm = () => rmSync(h.dataDir, { recursive: true, force: true });
    try {
      rm();
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      rm();
    }
  }
});

describe("agent host", { timeout: 30_000 }, () => {
  it("the kernel learns the shown language at start and at each change", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true, locale: "en" });
    expect(await h.rpc.request("debug.locale")).toEqual({ locale: "en", relocalized: 0 });
    const agents = join(h.root, "AGENTS.md");
    const template = (lang: string) => readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "kernel", "templates", lang, "AGENTS.md"), "utf8");
    expect(readFileSync(agents, "utf8")).toBe(template("en"));
    h.rpc.notify("settings.locale", { locale: "fr" });
    // The kernel's relocalize ran: the untouched AGENTS.md switched to French.
    await until(() => readFileSync(agents, "utf8") === template("fr"), 5_000);
    expect(await h.rpc.request("debug.locale")).toEqual({ locale: "fr", relocalized: 1 });
  });

  it("a language change that lands while the kernel is starting is applied once it is up", async () => {
    const h = startHost();
    const started = h.rpc.request("start", { agentProfile: "claude", aiEnabled: true, locale: "en" });
    h.rpc.notify("settings.locale", { locale: "fr" });
    await started;
    const agents = join(h.root, "AGENTS.md");
    const french = readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "kernel", "templates", "fr", "AGENTS.md"), "utf8");
    await until(() => existsSync(agents) && readFileSync(agents, "utf8") === french, 5_000);
  });

  it("the host starts the external MCP without the kernel", async () => {
    const h = startHost();
    h.rpc.notify("lab.enabled", { on: true });
    let e: { server: { state: string; port?: number } } | undefined;
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      e = await h.rpc.request("external.list");
      if (e!.server.state === "ready") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(e?.server.state).toBe("ready");
    expect(e?.server.port).toBeGreaterThan(0);
    expect(existsSync(join(h.root, ".ressac", "mcp.json"))).toBe(false);
  });

  it("tier-3 RPCs answer lab-off", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true, lab: false });
    await expect(h.rpc.request("workflow.read", { target: { type: "action", id: "rappel" } })).rejects.toThrow("lab-off");
    await expect(h.rpc.request("actions.list")).rejects.toThrow("lab-off");
    await expect(h.rpc.request("sites.list")).rejects.toThrow("lab-off");
    await expect(h.rpc.request("external.list")).rejects.toThrow("lab-off");
    await expect(h.rpc.request("apps.act", { folder: "essai", action: "launch", window: "f1" })).rejects.toThrow("lab-off");
    // Tier 2 still answers, and the chrome's shutdown paths are not refused.
    expect(await h.rpc.request("home.read")).not.toBeNull();
    await h.rpc.request("sites.closed", { id: "x" });
  });

  it("lab.enabled reaches the kernel: a running action stops when the lab goes off", async () => {
    const { writeRunnableAction } = await import("../e2e/actions");
    const h = startHost();
    // A code block that never answers: the run lasts until it is stopped.
    await writeRunnableAction(h.dataDir, "attente", { name: "Attente", code: "export default () => new Promise(() => {});" });
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true, lab: true });
    const running = async () => (await h.rpc.request<{ running: unknown[] }>("actions.live")).running.length;
    const launched = h.rpc.request<{ status: string }>("actions.launch", { id: "attente", input: null });
    await expect.poll(running, { timeout: 20_000 }).toBe(1);
    h.rpc.notify("lab.enabled", { on: false });
    expect((await launched).status).toBe("interrupted");
  });

  it("the Atelier follows the lab: an open Atelier session is relaunched in Navigateur, workshop while off stays Navigateur", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true, lab: true });
    h.rpc.notify("agent.mode", { mode: "workshop" });
    const ready = () => h.data().split("fake agent ready>").length;
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => ready() > 1);
    const before = ready();
    h.rpc.notify("lab.enabled", { on: false });
    await until(() => ready() > before);
    // Workshop asked while the lab is off (an old AI-off session saved in Atelier): the kernel would refuse it, Navigateur opens.
    h.rpc.notify("agent.mode", { mode: "workshop" });
    const again = ready();
    await h.rpc.request("agent.start", { window: "f2", size: { cols: 80, rows: 24 } });
    await until(() => ready() > again);
    expect(JSON.stringify(h.states)).not.toContain("labo");
  });

  it("AI off: start runs no docker and makes no kernel; ai.enabled turns it on, then off", async () => {
    const h = startHost();
    const calls = () => (existsSync(h.log) ? readFileSync(h.log, "utf8") : "");
    expect(await h.rpc.request("start", { agentProfile: "claude", aiEnabled: false })).toBe(null);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(calls()).toBe("");
    expect(existsSync(join(h.root, ".ressac", "mcp.json"))).toBe(false);
    // The session fails with « ai-off » (the panel shows an error state); nothing reaches docker.
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => JSON.stringify(h.states).includes("ai-off"));
    expect(calls()).toBe("");
    await h.rpc.request("ai.enabled", { on: true });
    expect(existsSync(join(h.root, ".ressac", "mcp.json"))).toBe(true);
    expect(calls()).toMatch(/^info/m);
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    const states = h.states.length;
    await h.rpc.request("ai.enabled", { on: false });
    await h.rpc.request("agent.start", { window: "f2", size: { cols: 80, rows: 24 } });
    await until(() => JSON.stringify(h.states.slice(states)).includes("ai-off"));
  });

  it("off then on sent back to back: the kernel is up and the apps woken again at the end", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    // The apps' orphan sweep runs at each wake.
    const sweeps = () => (existsSync(join(h.root, "fake-docker-stops.log")) ? readFileSync(join(h.root, "fake-docker-stops.log"), "utf8").split("RESSAC_APP=.*").length - 1 : 0);
    await until(() => sweeps() === 1);
    // A running session makes the off's stops take a while.
    await h.rpc.request("agent.start", { window: "f0", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    h.rpc.notify("ai.enabled", { on: false });
    // Off is under way (its stops in flight) when on arrives.
    await h.rpc.request("access.state");
    h.rpc.notify("ai.enabled", { on: true });
    await until(() => sweeps() === 2);
    const before = h.data().split("fake agent ready>").length;
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().split("fake agent ready>").length > before);
  });

  it("AI off: the host refuses what reaches Docker or Ollama", async () => {
    const { createServer } = await import("node:http");
    let requests = 0;
    const ollama = createServer((_req, res) => (requests++, res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}')));
    await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
    try {
      const h = startHost({ RESSAC_OLLAMA_URL: `http://127.0.0.1:${(ollama.address() as { port: number }).port}` });
      expect(await h.rpc.request("start", { agentProfile: "claude", aiEnabled: false })).toBe(null);
      expect(await h.rpc.request("ask.usable")).toBe(false);
      await h.rpc.request("ask.warm");
      await expect(h.rpc.request("ask.find", { question: "q" })).rejects.toThrow("ai-off");
      await expect(h.rpc.request("apps.act", { folder: "essai", action: "launch", window: "f1" })).rejects.toThrow("ai-off");
      await expect(h.rpc.request("settings.startDocker")).rejects.toThrow("ai-off");
      await expect(h.rpc.request("settings.pullModel", { name: "gemma" })).rejects.toThrow("ai-off");
      await new Promise((r) => setTimeout(r, 500));
      expect(requests).toBe(0);
      expect(existsSync(h.log) ? readFileSync(h.log, "utf8") : "").toBe("");
    } finally {
      ollama.close();
    }
  });

  it("AI on with the data of an older Ressac (its own Ollama downloaded): nothing calls, starts or installs Ollama", async () => {
    const { createServer } = await import("node:http");
    let requests = 0;
    const ollama = createServer((_req, res) => (requests++, res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[{"name":"gemma4:e4b-mlx"}],"version":"0.40.13"}')));
    await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
    try {
      const marker = join(tmpdir(), `ressac-old-ollama-${process.pid}-${Date.now()}`);
      const h = startHost({ RESSAC_OLLAMA_URL: `http://127.0.0.1:${(ollama.address() as { port: number }).port}` }, (dataDir) => {
        // The copy an older Ressac downloaded: it would leave a marker if anything ran it.
        mkdirSync(join(dataDir, "ollama", "0.40.13"), { recursive: true });
        writeFileSync(join(dataDir, "ollama", "0.40.13", "ollama"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
      });
      expect(await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true })).toEqual({ agent: expect.any(String) });
      const state = (await h.rpc.request("ai.state")) as Record<string, unknown>;
      expect(state.verification).toEqual({ decision: expect.any(Boolean), embed: expect.any(Boolean) });
      expect(state).not.toHaveProperty("ollama");
      await expect(h.rpc.request("settings.startOllama")).rejects.toThrow();
      expect(await h.rpc.request("settings.pullModel", { name: "ollama" })).toMatchObject({ ok: false });
      await new Promise((r) => setTimeout(r, 500));
      expect(requests).toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      ollama.close();
    }
  });

  it("creates the space and MCP config, list_tabs goes through Firefox", async () => {
    const h = startHost();
    expect(await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true })).toEqual({ agent: expect.any(String) });
    expect(existsSync(join(h.root, ".ressac", "mcp.json"))).toBe(true);
    const r = await callMcpTool(h.root, "list_tabs");
    expect(r.text).toContain("onglet non partagé");
  });

  it("a private tab is hidden from the agent", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    expect((await callMcpTool(h.root, "read_tab", { id: "t3" })).text).not.toBe(PRIVATE_TEXT);
    h.rpc.notify("privateTabs", { privateTabs: ["t3"], activePrivate: true });
    await h.rpc.request("access.state"); // stdin is read in order: the notification is applied
    expect((await callMcpTool(h.root, "read_tab", { id: "t3" })).text).toBe(PRIVATE_TEXT);
    expect((await callMcpTool(h.root, "current_page")).text).toBe(PRIVATE_TEXT);
  });

  it("capture_screen returns the PNG Firefox sent", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true, lab: true });
    expect((await callMcpTool(h.root, "capture_screen", { id: "t1" })).image).toBe(png);
  });

  it("the terminal reaches the fake agent", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    h.rpc.notify("agent.write", { window: "f1", data: "bonjour\r" });
    await until(() => h.data().includes("bonjour"));
  });

  it("outflow: keystrokes and the ⌘T question count as typed, prefills do not, closing the window forgets", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    const check = (window: string, text: string) => h.rpc.request("debug.outflowCheck", { window, text });
    const iban = "FR7630006000011234567890189";
    const key = "ghp_x7Kq9LmN2pRs4TuVw6YzA8bCdEfGhJ1kMn3P";
    // Prefill is not typed: the tab title in the context prefix stays a secret the user never wrote.
    h.rpc.notify("agent.panelOpened", { window: "f1", tab: { id: "t1", title: iban, url: "https://un.test/", space: "Perso" } });
    expect(await check("f1", iban)).toMatchObject({ kind: "iban" });
    h.rpc.notify("agent.write", { window: "f1", data: `${iban}\r` });
    expect(await check("f1", iban)).toBeNull();
    // ⌘T before the window's agent runs (its usual case): the question is typed once written into the new conversation,
    // as written: masked, its key went as a label, so the key itself was never typed; the page titles shown with it are not typed.
    await h.rpc.request("ask.handOff", { window: "f2", question: `corrige ${key} et ok`, shown: [{ url: "https://un.test/", title: iban, lastVisit: "2026-11-19" }] });
    await h.rpc.request("agent.start", { window: "f2", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("received: corrige"));
    expect(h.data()).toMatch(/received: corrige ⟨[a-z]+-[a-z0-9]{8}⟩ et ok/);
    expect(h.data()).not.toContain(key);
    expect(await check("f2", key)).toMatchObject({ kind: "api-key" });
    expect(await check("f2", iban)).toMatchObject({ kind: "iban" });
    h.rpc.notify("agent.closeWindow", { window: "f1" });
    expect(await check("f1", iban)).toMatchObject({ kind: "iban" });
    // Memory made again while the agent stops (here a late keystroke) is forgotten once it has stopped.
    h.rpc.notify("agent.closeWindow", { window: "f2" });
    h.rpc.notify("agent.write", { window: "f2", data: `${key}\r` });
    expect(await check("f2", key)).toBeNull();
    const end = Date.now() + 10_000;
    while ((await check("f2", key)) === null) {
      if (Date.now() > end) throw new Error("the closed window's memory was not forgotten after the stop");
      await new Promise((r) => setTimeout(r, 25));
    }
    // A window reopened on the same id (chrome/store/windows.ts reuses the last one) keeps its new memory past the old stop.
    await agentReady(h, "f3");
    const stops = sessionStops(h);
    h.rpc.notify("agent.closeWindow", { window: "f3" });
    await h.rpc.request("agent.start", { window: "f3", size: { cols: 80, rows: 24 } });
    h.rpc.notify("agent.write", { window: "f3", data: `${key}\r` });
    await until(() => sessionStops(h) > stops);
    await new Promise((r) => setTimeout(r, 300));
    expect(await check("f3", key)).toBeNull();
  });

  it("a repeat demarrer with the same profile keeps the kernel and its sessions", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    const mcp = readFileSync(join(h.root, ".ressac", "mcp.json"), "utf8");
    const stops = readFileSync(join(h.root, "fake-docker-stops.log"), "utf8"); // start-up orphan sweep only
    expect(await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true })).toEqual({ agent: expect.any(String) });
    expect(readFileSync(join(h.root, ".ressac", "mcp.json"), "utf8")).toBe(mcp);
    h.rpc.notify("agent.write", { window: "f1", data: "encore\r" });
    await until(() => h.data().includes("encore"));
    expect(readFileSync(join(h.root, "fake-docker-stops.log"), "utf8")).toBe(stops);
  });

  it("agent.profils asked while the kernel starts lists the default profile it prepares", async () => {
    const h = startHost();
    mkdirSync(join(h.root, ".ressac", "profiles"), { recursive: true });
    writeFileSync(join(h.root, ".ressac", "profiles", "autre.json"), JSON.stringify({ id: "autre", name: "Autre", interactive: ["a"], nonInteractive: ["a"], mcpConfig: "claude-json" }));
    const started = h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    expect((await h.rpc.request<{ id: string }[]>("agent.profiles")).map((p) => p.id)).toEqual(["autre", "claude", "codex"]);
    await started;
  });

  const args = (h: Host) => JSON.parse(readFileSync(join(h.root, "fake-agent-args.json"), "utf8")) as string[];
  const stopsLog = (h: Host) => (existsSync(join(h.root, "fake-docker-stops.log")) ? readFileSync(join(h.root, "fake-docker-stops.log"), "utf8") : "");
  const sessionStops = (h: Host) => stopsLog(h).split("\n").filter((l) => l.includes("ressac-session-")).length;
  /** Starts the window's agent and waits for its prompt; returns the arguments it got. */
  const agentReady = async (h: Host, f: string) => {
    const before = h.data().split("fake agent ready>").length;
    await h.rpc.request("agent.start", { window: f, size: { cols: 80, rows: 24 } });
    await until(() => h.data().split("fake agent ready>").length > before);
    return args(h);
  };

  it("changing the default does not touch open agents", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    await agentReady(h, "f1");
    const before = stopsLog(h);
    expect(await h.rpc.request("start", { agentProfile: "codex", aiEnabled: true })).toEqual({ agent: expect.any(String) });
    expect((await agentReady(h, "f2"))[0]).toBe("codex");
    expect(stopsLog(h)).toBe(before);
    expect(await h.rpc.request("agent.current", { window: "f1" })).toBe("claude");
  });

  it("agent.switch: only this window's agent, resumed on the way back", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    const first = await agentReady(h, "f1");
    const id = first[first.indexOf("--session-id") + 1];
    // Claude resumes only a conversation that got a message.
    h.rpc.notify("agent.write", { window: "f1", data: "hi\r" });
    await until(() => h.data().includes("received: hi"));
    const stops = sessionStops(h);
    const ready = h.data().split("fake agent ready>").length;
    await h.rpc.request("agent.switch", { window: "f1", profile: "codex" });
    await until(() => h.data().split("fake agent ready>").length > ready);
    expect(args(h)[0]).toBe("codex");
    await until(() => sessionStops(h) > stops);
    expect(await h.rpc.request("agent.current", { window: "f1" })).toBe("codex");
    const again = h.data().split("fake agent ready>").length;
    await h.rpc.request("agent.switch", { window: "f1", profile: "claude" });
    await until(() => h.data().split("fake agent ready>").length > again);
    expect(args(h).join(" ")).toContain(`--resume ${id}`);
    await h.rpc.request("agent.switch", { window: "f1", profile: "../x" });
    expect(await h.rpc.request("agent.current", { window: "f1" })).toBe("claude");
  });

  it("codex with the compatible API: engine arguments through the relay, never the key", async () => {
    const key = "sk-secret-123";
    const keyFile = join(mkdtempSync(join(tmpdir(), "ressac-key-")), "key");
    writeFileSync(keyFile, key);
    const k = startHost({ RESSAC_TEST_KEYCHAIN: keyFile });
    k.rpc.notify("agent.codexEngine", { engine: { kind: "api", apiUrl: "https://api.example/v1", apiModel: "m", ollamaUrl: "", ollamaModel: "" } });
    await k.rpc.request("start", { agentProfile: "codex", aiEnabled: true });
    const a = await agentReady(k, "f1");
    expect(a[0]).toBe("codex");
    expect(a).toContain('model_provider="ressac-api"');
    expect(a[a.indexOf("-m") + 1]).toBe("m");
    expect(a.some((x) => x.includes(key))).toBe(false);
    expect(readFileSync(k.log, "utf8")).not.toContain(key);
  });

  it("claude with the compatible API: the env holds the relay token, never the key", async () => {
    const key = "sk-secret-456";
    const keyFile = join(mkdtempSync(join(tmpdir(), "ressac-key-")), "key");
    writeFileSync(`${keyFile}.claude`, key);
    const k = startHost({ RESSAC_TEST_KEYCHAIN: keyFile });
    k.rpc.notify("agent.claudeEngine", { engine: { kind: "api", apiUrl: "https://api.example/v1", apiModel: "m", ollamaUrl: "", ollamaModel: "" } });
    await k.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    const a = await agentReady(k, "f1");
    expect(a.some((x) => x.includes(key))).toBe(false);
    const envFile = join(k.dataDir, "workspace", "fake-agent-env.json");
    await until(() => existsSync(envFile));
    const env = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    expect(env.ANTHROPIC_AUTH_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(env)).not.toContain(key);
    expect(readFileSync(k.log, "utf8")).not.toContain(key);
  });

  it("claude with the compatible API and no key: NO_KEY, never the subscription", async () => {
    const h = startHost();
    h.rpc.notify("agent.claudeEngine", { engine: { kind: "api", apiUrl: "https://api.example", apiModel: "m", ollamaUrl: "", ollamaModel: "" } });
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.states.some((e) => (e as { state: string }).state === "error"));
    expect(h.states.at(-1)).toEqual({ state: "error", message: "Aucune clé enregistrée pour l'API compatible (Réglages › Agent)." });
  });

  it("codex engine incomplete: no key → the panel says why", async () => {
    const h = startHost();
    h.rpc.notify("agent.codexEngine", { engine: { kind: "api", apiUrl: "https://api.example/v1", apiModel: "m", ollamaUrl: "", ollamaModel: "" } });
    await h.rpc.request("start", { agentProfile: "codex", aiEnabled: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.states.some((e) => (e as { state: string }).state === "error"));
    expect(h.states.at(-1)).toEqual({ state: "error", message: "Aucune clé enregistrée pour l'API compatible (Réglages › Agent)." });
  });

  it("docker absent → etat docker-absent", async () => {
    const h = startHost({ FAKE_DOCKER_ABSENT: "1" });
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.states.some((e) => (e as { state: string }).state === "docker-absent"));
  });

  it("a console.log in the host never reaches stdout", async () => {
    const h = startHost();
    h.rpc.notify("debug.log", { text: "bruit-sur-stdout" });
    expect(await h.rpc.request("access.state")).toEqual({ agent: expect.any(String), tabs: {} });
    expect(h.stderr()).toContain("bruit-sur-stdout");
  });

  it("uses its own docker container", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    const lines = readFileSync(h.log, "utf8").split("\n");
    expect(lines.some((l) => l.includes("ressac-workshop-firefox"))).toBe(true);
    expect(lines.filter((l) => / ressac-workshop( |$)/.test(l))).toEqual([]);
  });

  it("publishes its own port range, 5300-5319", async () => {
    const h = startHost({ FAKE_DOCKER_NO_CONTAINER: "1" });
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    const run = readFileSync(h.log, "utf8").split("\n").find((l) => l.startsWith("run -d"));
    expect(run).toContain("127.0.0.1:5300-5319:5300-5319");
    expect(run).toContain("RESSAC_PORTS=5300-5319");
  });

  it("arreter stops sessions, then the process exits 0", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    await h.rpc.request("stop");
    expect(await h.exited).toBe(0);
    expect(readFileSync(join(h.root, "fake-docker-stops.log"), "utf8")).toContain("ressac-session");
  });

  describe("the local AI servers at quit", () => {
    /** A fake llama-server: notes its PID (its group, launched detached) in its model folder and waits. */
    const withLlama = (env: Record<string, string> = {}) => {
      const bin = join(realpathSync(mkdtempSync(join(tmpdir(), "ressac-llama-"))), "llama-server");
      writeFileSync(bin, '#!/bin/sh\necho $$ > llama.pid\nexec sleep 60\n', { mode: 0o755 });
      const h = startHost({ RESSAC_LLAMA_SERVER: bin, ...env }, (dataDir) => {
        mkdirSync(join(dataDir, "local-ai", "embed"), { recursive: true });
        writeFileSync(join(dataDir, "local-ai", "embed", "embeddinggemma-300M-Q8_0.gguf"), "gguf");
      });
      const pidFile = join(h.dataDir, "local-ai", "embed", "llama.pid");
      const alive = () => {
        try {
          process.kill(-Number(readFileSync(pidFile, "utf8")), 0);
          return true;
        } catch {
          return false;
        }
      };
      return { h, pidFile, alive };
    };
    const warm = async (h: Host, pidFile: string) => {
      await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
      await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
      await h.rpc.request("ask.warm"); // starts the search model's llama-server
      await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    };

    it("stop stops the llama-servers first, before a slow session stop", async () => {
      const { h, pidFile, alive } = withLlama({ FAKE_DOCKER_SLOW_SESSION_STOP: "4" });
      await warm(h, pidFile);
      expect(alive()).toBe(true);
      const stopped = h.rpc.request("stop").catch(() => {});
      await until(() => !alive(), 2000); // well before the 4 s session stop ends
      await stopped;
      expect(await h.exited).toBe(0);
    });

    it("SIGTERM (Firefox's kill after its 5 s): exits 0 and kills the llama-servers' groups", async () => {
      const { h, pidFile, alive } = withLlama();
      await warm(h, pidFile);
      h.child.kill("SIGTERM");
      expect(await h.exited).toBe(0);
      await until(() => !alive(), 2000);
    });
  });

  it("open_workflow: the window's selection on its open workflow, forgotten when the window closes", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true, lab: true });
    const sessions = join(h.root, ".ressac", "sessions");
    /** Starts an agent session for w1 and returns its own MCP config (its token names the window). */
    const session = async () => {
      const before = existsSync(sessions) ? readdirSync(sessions) : [];
      await h.rpc.request("agent.start", { window: "w1", size: { cols: 80, rows: 24 } });
      let config: string | undefined;
      await until(() => !!(config = existsSync(sessions) ? readdirSync(sessions).find((f) => !before.includes(f)) : undefined));
      return join(sessions, config!);
    };
    const first = await session();
    h.rpc.notify("workflow.selection", { window: "w1", target: { type: "widget", id: "veille" }, block: "tri" });
    h.rpc.notify("windows.active", { w1: "ressac://workflow/veille" });
    await h.rpc.request("access.state"); // stdin is read in order: the notifications are applied
    expect((await callMcpTool(h.root, "open_workflow", {}, first)).text).toBe(JSON.stringify({ widget: "veille", block: "tri" }));
    h.rpc.notify("agent.closeWindow", { window: "w1" });
    await until(() => !existsSync(first));
    expect((await callMcpTool(h.root, "open_workflow", {}, await session())).text).toBe(NO_WORKFLOW_OPEN);
  });

  it("workflow.* answer a bad input with the UI's shapes", async () => {
    const h = startHost();
    h.rpc.notify("lab.enabled", { on: true });
    const target = { type: "widget", id: "veille" };
    const bad = { type: "widget", id: "../x" };
    const failure = { ok: false, error: "Argument invalide" };
    expect(await h.rpc.request("workflow.read", { target: bad })).toBeNull();
    expect(await h.rpc.request("workflow.save", { target: target, draft: { version: 2 } })).toEqual({ ...failure, warnings: [] });
    expect(await h.rpc.request("workflow.readCode", { target: target, name: "Tri.mjs" })).toEqual({ error: "Argument invalide" });
    expect(await h.rpc.request("workflow.saveCode", { target: target, name: "tri.mjs", text: 1 })).toEqual(failure);
    expect(await h.rpc.request("workflow.replay", { target: target, run: "x/y", block: "tri" })).toEqual(failure);
    expect(await h.rpc.request("workflow.run", { target: bad })).toEqual({});
  });

  it("adresseSitePermise follows the open app's domains, false once it is closed", async () => {
    const site = { id: "site:vidola", title: "Vidola", url: "https://vidola.test/", space: "", site: "vidola", domain: "vidola.test", hash: "e" };
    const navigations: string[] = [];
    const h = startHost({}, (dataDir) => {
      const folder = join(dataDir, "workspace", "sites", "vidola");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "site.json"), JSON.stringify({ name: "Vidola", url: "https://vidola.test/", domains: ["vidola.test"], login: ["compte.test"] }));
    }, {
      handlers: {
        listTabs: () => [...tabs, site],
        askWidgetData: () => true,
        // The agent wrote these addresses: the « agent-address » card is asked first, even on the app's domains.
        askAddress: () => true,
        navigate: ([, url]: [string, string]) => void navigations.push(url),
        "sites.openIds": () => ["vidola"],
      },
    });
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    await h.rpc.request("sites.ready");
    const navigate = (url: string) => callMcpTool(h.root, "navigate", { id: "site:vidola", url });
    expect((await navigate("https://vidola.test/film/2")).text).toBe("Appli de site site:vidola → https://vidola.test/film/2");
    // Sign-in domains and other sites are not the app's: nothing loads.
    expect(await navigate("https://compte.test/connexion")).toEqual({ text: navigationOutsideSite("https://compte.test/connexion"), error: true });
    expect(await navigate("https://pub.test/x")).toEqual({ text: navigationOutsideSite("https://pub.test/x"), error: true });
    h.rpc.notify("sites.closed", { id: "vidola" });
    await h.rpc.request("access.state"); // stdin is read in order: the notification is applied
    expect(await navigate("https://vidola.test/film/3")).toEqual({ text: navigationOutsideSite("https://vidola.test/film/3"), error: true });
    expect(navigations).toEqual(["https://vidola.test/film/2"]);
  });

  it("stdin closed → the host exits", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    h.child.stdin.end();
    expect(await h.exited).toBe(0);
  });
});

describe("passport", { timeout: 60_000 }, () => {
  // Built from parts: no whole personal value sits in the source.
  const given = ["Zéphy", "rine"].join("");
  const family = ["Quinta", "valle"].join("");
  const entry = { id: "0000000000000001", field: "nom", value: { given, family }, variants: [], origins: [], how: "typed", created: "2026-11-23T10:00:00.000Z", updated: "2026-11-23T10:00:00.000Z" };

  it("passport.* never write a value to stderr nor to an error; a bad call gets the fixed text", async () => {
    const h = startHost({}, undefined, { passport: false });
    expect(await h.rpc.request("passport.replace", { profile: "perso", entries: [entry] })).toEqual({ ok: true, uncovered: 0 });
    const refused = (p: unknown) => h.rpc.request("passport.replace", p).then(() => null, (e: Error) => e.message);
    expect(await refused({ profile: `../${given}`, entries: [entry] })).toBe("invalid passport");
    expect(await refused({ profile: "perso", entries: { given } })).toBe("invalid passport");
    expect(await h.rpc.request("passport.drop", { profile: `${family}/x` }).then(() => null, (e: Error) => e.message)).toBe("invalid passport");
    expect(await h.rpc.request("passport.ready", { unreadable: ["autre"] })).toEqual({ ok: true });
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    expect(await h.rpc.request("passport.replace", { profile: "autre", entries: [entry, { ...entry, id: "0000000000000002", value: { given: family, family: given } }] })).toEqual({ ok: true, uncovered: 0 });
    expect(await h.rpc.request("agent.masking", { window: "f1" })).toMatchObject({ passportUnreadable: [] });
    h.child.kill("SIGTERM");
    await h.exited;
    expect(h.stderr()).not.toContain(given);
    expect(h.stderr()).not.toContain(family);
  });

  it("an agent session starts only once the passports are in: Ressac's own texts to it are masked with them", async () => {
    const h = startHost({}, undefined, { passport: false });
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    const starting = h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    const sessionRan = () => (existsSync(h.log) ? readFileSync(h.log, "utf8") : "").includes("echo $$ > /tmp/ressac-session-");
    // Must not happen: the session's command run before ready (the window starts once agent.start is sent).
    await new Promise((r) => setTimeout(r, 1_000));
    expect(sessionRan()).toBe(false);
    await h.rpc.request("passport.ready", { unreadable: [] });
    await starting;
    await until(sessionRan);
    await until(() => h.data().includes("fake agent ready>"));
  });

  it("Review Focus 3: a host, first or restarted, answers no tool before the chrome pushed the passports again", async () => {
    let pushed = false;
    // `pushed` turns true only as ready is sent: an answer after the replace but before ready (a gate on the first
    // replace) lands in the window between them and fails the test.
    const push = async (h: Host) => {
      await h.rpc.request("passport.replace", { profile: "perso", entries: [entry] });
      await new Promise((r) => setTimeout(r, 500));
      pushed = true;
      await h.rpc.request("passport.ready", { unreadable: [] });
    };
    const firstAnswerAfterPush = async (h: Host) => {
      pushed = false;
      await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
      let answeredEarly = false;
      const call = callMcpTool(h.root, "list_tabs").then((r) => ((answeredEarly = !pushed), r));
      // Must not happen: an answer before the push (the window starts once the call is sent).
      await new Promise((r) => setTimeout(r, 500));
      await push(h);
      expect((await call).text).toContain("onglet non partagé");
      expect(answeredEarly).toBe(false);
    };
    const first = startHost({}, undefined, { passport: false });
    await firstAnswerAfterPush(first);
    first.child.kill("SIGKILL");
    await first.exited;
    await firstAnswerAfterPush(startHost({}, undefined, { passport: false, dataDir: first.dataDir }));
  });
});

describe("history", { timeout: 30_000 }, () => {
  const visit = (h: Host, url: string, title: string, o: { private?: boolean; spaceId?: string } = {}) =>
    h.rpc.notify("history.record", { url, title: title, spaceId: o.spaceId ?? "e1", private: o.private ?? false });

  // A notification runs a microtask after its line, a request at once: a round trip lets the notifications before it land.
  const settle = (h: Host) => h.rpc.request("access.state");

  it("noted visits are searched, cleared and survive the agent's kernel", async () => {
    // No docker, no demarrer: the history must not need the agent's kernel.
    const h = startHost();
    visit(h, "https://a.test/", "Page A");
    h.rpc.notify("history.title", { url: "https://a.test/", spaceId: "e1", title: "Page A bis" });
    await settle(h);
    expect(await h.rpc.request("history.search", { text: "page a" })).toEqual([
      expect.objectContaining({ title: "Page A bis", visits: 1, private: false }),
    ]);
    await h.rpc.request("history.clear", {});
    expect(await h.rpc.request("history.recent", {})).toEqual([]);
  });

  it("history.icon gives non-private visits their site's favicon", async () => {
    const h = startHost();
    visit(h, "https://a.test/", "A");
    visit(h, "https://p.test/", "P", { private: true, spaceId: "p" });
    h.rpc.notify("history.icon", { url: "https://a.test/", spaceId: "e1", icon: "data:image/png;base64,AAAA" });
    h.rpc.notify("history.icon", { url: "https://p.test/", spaceId: "p", icon: "data:image/png;base64,BBBB" });
    await settle(h);
    const recents = (await h.rpc.request("history.recent", {})) as { url: string; favicon: string | null }[];
    expect(Object.fromEntries(recents.map((v) => [v.url, v.favicon]))).toEqual({ "https://a.test/": "data:image/png;base64,AAAA", "https://p.test/": null });
  });

  it("search_history finds a non-private visit, never a private one", async () => {
    // The history card, accepted.
    const h = startHost({}, undefined, { handlers: { askWidgetData: () => true } });
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    visit(h, "https://a.test/", "Alpha");
    visit(h, "https://b.test/", "Alpha privé", { private: true });
    await settle(h);
    const r = await callMcpTool(h.root, "search_history", { query: "alpha" });
    expect(r.text).toContain("a.test");
    expect(r.text).not.toContain("b.test");
    expect((await callMcpTool(h.root, "read_history", { url: "https://a.test/" })).text).toBe("Rien de retenu pour cette page.");
  });

  it("retained text is found by the agent, never for a loopback URL", async () => {
    // The history card, accepted.
    const h = startHost({}, undefined, { handlers: { askWidgetData: () => true } });
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    visit(h, "https://a.test/", "Alpha");
    h.rpc.notify("history.keep", { url: "https://a.test/", spaceId: "e1", title: "Alpha", text: "Le chat dort" });
    visit(h, "http://127.0.0.1/x", "Local");
    h.rpc.notify("history.keep", { url: "http://127.0.0.1/x", spaceId: "e1", title: "Local", text: "Le chien veille" });
    await settle(h);
    expect((await callMcpTool(h.root, "search_history", { query: "chat" })).text).toContain("a.test");
    expect((await callMcpTool(h.root, "read_history", { url: "https://a.test/" })).text).toContain("Le chat dort");
    const recents = (await h.rpc.request("history.recent", {})) as { url: string; kept: boolean }[];
    expect(recents.find((v) => v.url === "http://127.0.0.1/x")?.kept).toBe(false);
  });

  it("an unreadable history database leaves the host and the agent running, without history", async () => {
    // A directory where the SQLite file should be: opening it throws.
    const h = startHost({}, (d) => mkdirSync(join(d, "history.sqlite")));
    visit(h, "https://a.test/", "Page A");
    expect(await h.rpc.request("history.recent", {})).toEqual([]);
    expect(await h.rpc.request("history.search", { text: "page" })).toEqual([]);
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    expect(h.stderr()).toContain("history");
  });

  it("history.import keeps a visit with a long title (cut), drops a long URL, and fails without a history", async () => {
    const h = startHost();
    const date = new Date().toISOString();
    const r = await h.rpc.request("history.import", { visits: [
      { url: "https://a.test/", title: "t".repeat(5000), date },
      { url: `https://b.test/${"x".repeat(2048)}`, title: "B", date },
    ] });
    expect(r).toEqual({ count: 1 });
    expect(await h.rpc.request("history.recent", {})).toEqual([expect.objectContaining({ url: "https://a.test/", title: "t".repeat(256) })]);
    const broken = startHost({}, (d) => mkdirSync(join(d, "history.sqlite")));
    await expect(broken.rpc.request("history.import", { visits: [] })).rejects.toThrow(/no history/);
  });

  it("a space turned private marks its visits", async () => {
    const h = startHost();
    visit(h, "https://a.test/", "Page A");
    h.rpc.notify("history.makePrivate", { spaceId: "e1" });
    await settle(h);
    expect(await h.rpc.request("history.recent", {})).toEqual([expect.objectContaining({ spaceId: "e1", private: true })]);
  });
});

describe("agent applications", { timeout: 30_000 }, () => {
  // Their own block, apart from every e2e file's (plans 35a and 35b).
  const APPS = { RESSAC_APP_PORTS: "15325-15329", RESSAC_APP_DELAY_MS: "3000" };
  type List = { workshop: string; apps: { folder: string; state: string; port?: number; favicon?: string; lastLaunch?: string }[] };
  /** Writes a project with an "ok" server: projets/essai, named Essai. */
  const writeAttempt = (dataDir: string) => {
    const path = join(dataDir, "workspace", "projects", "essai");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "serveur.mjs"),
      `import { createServer } from "node:http";
createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end('<title>Essai essai</title>');
}).listen(Number(process.env.PORT));
`,
    );
    writeFileSync(join(path, "ressac.json"), JSON.stringify({ type: "app", launch: "node serveur.mjs", name: "Essai" }));
  };
  /** A host with the essai project and a fake chrome noting the apps.* requests. */
  const startApps = (env: Record<string, string> = {}, handlers: Record<string, Handler> = {}) => {
    const chrome = { openings: [] as { folder: string; name: string; port: number }[], erased: [] as string[], changes: 0 };
    const h = startHost({ ...APPS, ...env }, writeAttempt, {
      handlers: {
        "apps.open": ([a]: [{ folder: string; name: string; port: number }]) => void chrome.openings.push(a),
        "apps.close": () => undefined,
        "apps.show": () => true,
        "apps.erase": ([d]: [string]) => void chrome.erased.push(d),
        "apps.change": () => void chrome.changes++,
        ...handlers,
      },
    });
    // The apps need AI and the lab on (apps.act is refused while either is off).
    h.rpc.notify("ai.enabled", { on: true });
    h.rpc.notify("lab.enabled", { on: true });
    return { h, chrome };
  };
  const list = (h: Host) => h.rpc.request<List>("apps.list");
  const attempt = async (h: Host) => (await list(h)).apps.find((a) => a.folder === "essai");
  const act = (h: Host, action: string, folder = "essai") => h.rpc.notify("apps.act", { folder: folder, action, window: "f1" });
  const stops = (h: Host) => (existsSync(join(h.root, "fake-docker-stops.log")) ? readFileSync(join(h.root, "fake-docker-stops.log"), "utf8") : "");
  const launched = async (h: Host, chrome: { openings: unknown[] }) => {
    act(h, "launch");
    await until(() => chrome.openings.length > 0, 20_000);
    expect((await attempt(h))?.state).toBe("running");
  };

  it("applications.liste lists essai with atelier ok, without waiting for docker", async () => {
    // docker info answers after 8 s.
    const { h } = startApps({ FAKE_DOCKER_SLOW: "1" });
    const t = Date.now();
    const l = await list(h);
    expect(Date.now() - t).toBeLessThan(4000);
    expect(l.workshop).toBe("ok");
    expect(l.apps).toEqual([expect.objectContaining({ folder: "essai", name: "Essai", state: "stopped" })]);
  });

  it("lancer asks the chrome to open the app on a port of RESSAC_APP_PORTS, and notes dernierLancement", async () => {
    const { h, chrome } = startApps();
    await launched(h, chrome);
    const [a] = chrome.openings;
    expect(a).toMatchObject({ folder: "essai", name: "Essai" });
    expect(a!.port).toBeGreaterThanOrEqual(15325);
    expect(a!.port).toBeLessThanOrEqual(15329);
    const e = await attempt(h);
    expect(e).toMatchObject({ port: a!.port, lastLaunch: expect.any(String) });
    expect(Date.now() - Date.parse(e!.lastLaunch!)).toBeLessThan(30_000);
  });

  it("fenetreFermee by the user stops the app; a wanted close does not", async () => {
    const { h, chrome } = startApps();
    await launched(h, chrome);
    const before = stops(h);
    h.rpc.notify("apps.windowClosed", { folder: "essai", byUser: false });
    await new Promise((r) => setTimeout(r, 500));
    expect(stops(h).slice(before.length)).not.toContain("RESSAC_APP=essai");
    expect((await attempt(h))?.state).toBe("running");
    h.rpc.notify("apps.windowClosed", { folder: "essai", byUser: true });
    await until(() => stops(h).slice(before.length).includes("RESSAC_APP=essai"));
    expect((await attempt(h))?.state).toBe("stopped");
  });

  it("supprimer is refused while running, and for ../x", async () => {
    const { h, chrome } = startApps({}, {});
    mkdirSync(join(h.root, "x"), { recursive: true });
    await launched(h, chrome);
    act(h, "delete");
    act(h, "delete", "../x");
    await new Promise((r) => setTimeout(r, 500));
    await list(h);
    expect(existsSync(join(h.root, "projects", "essai", "ressac.json"))).toBe(true);
    expect(existsSync(join(h.root, "x"))).toBe(true);
    expect(chrome.erased).toEqual([]);
  });

  it("supprimer erases the folder, the memory and asks apps.effacer", async () => {
    const { h, chrome } = startApps();
    const memory = join(h.dataDir, "apps.json");
    h.rpc.notify("apps.note", { folder: "essai", frame: { x: 1, y: 2, width: 300, height: 200 } });
    await until(() => existsSync(memory) && readFileSync(memory, "utf8").includes("essai"));
    act(h, "delete");
    await until(() => !existsSync(join(h.root, "projects", "essai")));
    await until(() => chrome.erased.length > 0);
    expect(chrome.erased).toEqual(["essai"]);
    await until(() => !readFileSync(memory, "utf8").includes("essai"));
    expect((await list(h)).apps).toEqual([]);
    // Outside the container's mount.
    expect(existsSync(join(h.root, "apps.json"))).toBe(false);
  });

  it("noter keeps a data:image favicon of 64 KB at most", async () => {
    const { h, chrome } = startApps();
    const favicon = "data:image/png;base64," + "A".repeat(1000);
    h.rpc.notify("apps.note", { folder: "essai", favicon });
    await until(() => chrome.changes > 0);
    expect((await attempt(h))?.favicon).toBe(favicon);
    const too = "data:image/png;base64," + "A".repeat(64 * 1024);
    for (const f of [too, "data:text/html,<b>x</b>", "https://exemple.test/favicon.ico", 3])
      h.rpc.notify("apps.note", { folder: "essai", favicon: f });
    expect((await attempt(h))?.favicon).toBe(favicon);
  });

  it("deboguer pre-fills the window's agent and opens its panel", async () => {
    const given: unknown[] = [];
    const { h } = startApps({}, { "design.giveAgent": (p: unknown) => void given.push(p) });
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true, lab: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    act(h, "debug");
    await until(() => h.data().includes("essai"));
    await until(() => given.length > 0);
    expect(given).toEqual([["f1"]]);
  });

  it("the host stops the apps and the sessions on stdin close", async () => {
    const { h, chrome } = startApps();
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true, lab: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    await launched(h, chrome);
    const before = stops(h).length;
    h.child.stdin.end();
    expect(await h.exited).toBe(0);
    // Started first, then run side by side with the sessions' stop: both happen before the exit.
    const after = stops(h).slice(before);
    expect(after).toContain("RESSAC_APP=essai");
    expect(after).toContain("cat /tmp/ressac-session-");
  });

  it("a slow apps stop at quit does not hold back the sessions' stop", async () => {
    const { h, chrome } = startApps({ FAKE_DOCKER_SLOW_APP_STOP: "4" });
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true, lab: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    await launched(h, chrome);
    const before = stops(h).length;
    h.child.stdin.end();
    // The apps' docker answers after 4 s: the sessions are stopped well before.
    await until(() => stops(h).slice(before).includes("cat /tmp/ressac-session-"), 2_500);
    expect(await h.exited).toBe(0);
  });

  it("a failed apps stop at quit still stops the sessions", async () => {
    const { h } = startApps({ RESSAC_TEST_APPS_STOP_FAILS: "1" });
    await h.rpc.request("start", { agentProfile: "claude", aiEnabled: true, lab: true });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    const before = stops(h).length;
    h.child.stdin.end();
    expect(await h.exited).toBe(0);
    expect(stops(h).slice(before)).toContain("cat /tmp/ressac-session-");
    expect(h.stderr()).toContain("simulated apps stop");
  });

  it("lab off stops the apps and the external MCP", async () => {
    const { h, chrome } = startApps();
    await launched(h, chrome);
    let port = 0;
    await expect.poll(async () => (port = (await h.rpc.request<{ server: { state: string; port?: number } }>("external.list")).server.port ?? 0), { timeout: 10_000 }).toBeGreaterThan(0);
    const reaches = () => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
    expect(await reaches()).toBe(true);
    const before = stops(h);
    h.rpc.notify("lab.enabled", { on: false });
    await until(() => stops(h).slice(before.length).includes("RESSAC_APP=essai"));
    await expect.poll(reaches, { timeout: 10_000 }).toBe(false);
    await expect(h.rpc.request("apps.act", { folder: "essai", action: "launch", window: "f1" })).rejects.toThrow("lab-off");
  });

  it("appPortRange, the app tab and SchemaActionApplication", async () => {
    const { appPortRange, appTab } = await import("../host/applications");
    const { SchemaActionApplication } = await import("../shared/api");
    expect(appPortRange("15280-15284")).toEqual([15280, 15284]);
    expect(appPortRange(undefined)).toBeUndefined();
    expect(appTab({ folder: "essai", title: "T", url: "http://localhost:15280/" })).toEqual({ id: "app:essai", title: "T", url: "http://localhost:15280/", space: "", app: "essai" });
    const accepted = (folder: unknown, action: string) => SchemaActionApplication.safeParse({ folder: folder, action }).success;
    expect([["essai", "launch"], ["../x", "delete"], ["My Project", "delete"], ["My Project", "launch"], [".", "debug"], ["essai", "autre"], [3, "launch"]].map(([d, a]) => accepted(d, a as string))).toEqual([true, false, true, false, false, false, false]);
    expect(SchemaActionApplication.shape.action.options).toEqual(["launch", "stop", "relaunch", "open", "debug", "delete", "promote", "folder", "review"]);
    // Only these actions take a folder name that is not a launchable one; none takes a path.
    for (const action of SchemaActionApplication.shape.action.options) {
      const anyName = ["debug", "delete", "folder"].includes(action);
      expect(["essai", "My Project", ".."].map((d) => accepted(d, action)), action).toEqual([true, anyName, false]);
    }
  });
});
