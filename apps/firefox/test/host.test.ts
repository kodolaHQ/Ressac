import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { NO_WORKFLOW_OPEN, CONSOLE_UNLOCKED, CONSOLE_BACKGROUND_HIDDEN, OBSERVED_BACKGROUND_CONSOLE, REQUEST_REMOVED, PRIVATE_PROFILE_ERROR, hiddenTabs, navigationOutsideSite } from "../../../packages/kernel/src/index";
import { PRIVATE_TEXT } from "../../../packages/kernel/src/mcp/bridge";
import { DISABLED_CRASHES } from "../shared/extensions-messages";
import { hostPath, nodePath, tsxPath } from "../scripts/paths";
import { createRpc, type Handler, type Rpc } from "../shared/rpc";
import { installationImpossible, NOTHING_TO_REVIEW } from "../host/extensions/agent";
import { KEYS_ABSENT, deniedSignature } from "../host/extensions/amo";
import type { ExtensionCard, GrantResponse } from "../shared/extensions";
import { startFakeAmo } from "./fake-amo";
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

/** `o.dataDir`: restart on that folder; `o.handlers`: more requests answered as Firefox. */
function startHost(env: Record<string, string> = {}, prepare?: (dataDir: string) => void, o: { dataDir?: string; handlers?: Record<string, Handler> } = {}): Host {
  const dataDir = o.dataDir ?? realpathSync(mkdtempSync(join(tmpdir(), "webaios-host-")));
  prepare?.(dataDir);
  const root = join(dataDir, "workspace");
  const log = join(dataDir, "docker.log");
  const { WEBAIOS_CONTAINER: _, WEBAIOS_CONTAINER_PORTS: __, ...parent } = process.env;
  const child = spawn(nodePath, ["--import", tsxPath, hostPath], {
    env: {
      ...parent,
      WEBAIOS_DATA_DIR: dataDir,
      // The fake docker and fake agent write their traces there.
      WEBAIOS_ROOT: root,
      FAKE_DOCKER_LOG: log,
      WEBAIOS_HOST_TEST: "1",
      PATH: `${tools}:${process.env.PATH}`,
      // A free port: never the real 5279.
      WEBAIOS_PORT_MCP_EXTERNAL: "0",
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
      askPermission: () => true,
      "agent.data": (p: { data: string }) => void (data += p.data),
      "agent.state": (p: { state: unknown }) => void states.push(p.state),
      ...o.handlers,
    },
  });
  createInterface({ input: child.stdout }).on("line", (l) => rpc.receive(l));
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
  it("the host starts the external MCP without the kernel", async () => {
    const h = startHost();
    let e: { server: { state: string; port?: number } } | undefined;
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      e = await h.rpc.request("external.list");
      if (e!.server.state === "ready") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(e?.server.state).toBe("ready");
    expect(e?.server.port).toBeGreaterThan(0);
    expect(existsSync(join(h.root, ".webaios", "mcp.json"))).toBe(false);
  });

  it("creates the space and MCP config, list_tabs goes through Firefox", async () => {
    const h = startHost();
    expect(await h.rpc.request("start", { agentProfile: "claude" })).toEqual({ agent: expect.any(String) });
    expect(existsSync(join(h.root, ".webaios", "mcp.json"))).toBe(true);
    const r = await callMcpTool(h.root, "list_tabs");
    expect(r.text).toContain("onglet non partagé");
  });

  it("a private tab is hidden from the agent", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude" });
    expect((await callMcpTool(h.root, "read_tab", { id: "t3" })).text).not.toBe(PRIVATE_TEXT);
    h.rpc.notify("privateTabs", { privateTabs: ["t3"], activePrivate: true });
    await h.rpc.request("access.state"); // stdin is read in order: the notification is applied
    expect((await callMcpTool(h.root, "read_tab", { id: "t3" })).text).toBe(PRIVATE_TEXT);
    expect((await callMcpTool(h.root, "current_page")).text).toBe(PRIVATE_TEXT);
  });

  it("capture_screen returns the PNG Firefox sent", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude" });
    expect((await callMcpTool(h.root, "capture_screen", { id: "t1" })).image).toBe(png);
  });

  it("the terminal reaches the fake agent", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude" });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    h.rpc.notify("agent.write", { window: "f1", data: "bonjour\r" });
    await until(() => h.data().includes("bonjour"));
  });

  it("a repeat demarrer with the same profile keeps the kernel and its sessions", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude" });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    const mcp = readFileSync(join(h.root, ".webaios", "mcp.json"), "utf8");
    const stops = readFileSync(join(h.root, "fake-docker-stops.log"), "utf8"); // start-up orphan sweep only
    expect(await h.rpc.request("start", { agentProfile: "claude" })).toEqual({ agent: expect.any(String) });
    expect(readFileSync(join(h.root, ".webaios", "mcp.json"), "utf8")).toBe(mcp);
    h.rpc.notify("agent.write", { window: "f1", data: "encore\r" });
    await until(() => h.data().includes("encore"));
    expect(readFileSync(join(h.root, "fake-docker-stops.log"), "utf8")).toBe(stops);
  });

  it("agent.profils asked while the kernel starts lists the default profile it prepares", async () => {
    const h = startHost();
    mkdirSync(join(h.root, ".webaios", "profiles"), { recursive: true });
    writeFileSync(join(h.root, ".webaios", "profiles", "autre.json"), JSON.stringify({ id: "autre", name: "Autre", interactive: ["a"], nonInteractive: ["a"], mcpConfig: "claude-json" }));
    const started = h.rpc.request("start", { agentProfile: "claude" });
    expect((await h.rpc.request<{ id: string }[]>("agent.profiles")).map((p) => p.id)).toEqual(["autre", "claude"]);
    await started;
  });

  it("demarrer with another profile restarts the sessions", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude" });
    const profiles = join(h.root, ".webaios", "profiles");
    writeFileSync(join(profiles, "autre.json"), readFileSync(join(profiles, "claude.json"), "utf8").replace('"id": "claude"', '"id": "autre"'));
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    const stops = join(h.root, "fake-docker-stops.log");
    const before = readFileSync(stops, "utf8");
    h.states.length = 0;
    await h.rpc.request("start", { agentProfile: "autre" });
    await until(() => h.states.some((e) => (e as { state: string }).state === "active"));
    // The old session was stopped in the container.
    await until(() => readFileSync(stops, "utf8").slice(before.length).includes("webaios-session-"));
  });

  it("docker absent → etat docker-absent", async () => {
    const h = startHost({ FAKE_DOCKER_ABSENT: "1" });
    await h.rpc.request("start", { agentProfile: "claude" });
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
    await h.rpc.request("start", { agentProfile: "claude" });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    const lines = readFileSync(h.log, "utf8").split("\n");
    expect(lines.some((l) => l.includes("webaios-workshop-firefox"))).toBe(true);
    expect(lines.filter((l) => / webaios-workshop( |$)/.test(l))).toEqual([]);
  });

  it("publishes its own port range, 5300-5319", async () => {
    const h = startHost({ FAKE_DOCKER_NO_CONTAINER: "1" });
    await h.rpc.request("start", { agentProfile: "claude" });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    const run = readFileSync(h.log, "utf8").split("\n").find((l) => l.startsWith("run -d"));
    expect(run).toContain("127.0.0.1:5300-5319:5300-5319");
    expect(run).toContain("WEBAIOS_PORTS=5300-5319");
  });

  it("arreter stops sessions, then the process exits 0", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude" });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    await h.rpc.request("stop");
    expect(await h.exited).toBe(0);
    expect(readFileSync(join(h.root, "fake-docker-stops.log"), "utf8")).toContain("webaios-session");
  });

  it("open_workflow: the window's selection on its open workflow, forgotten when the window closes", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude" });
    const sessions = join(h.root, ".webaios", "sessions");
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
    h.rpc.notify("windows.active", { w1: "webaios://workflow/veille" });
    await h.rpc.request("access.state"); // stdin is read in order: the notifications are applied
    expect((await callMcpTool(h.root, "open_workflow", {}, first)).text).toBe(JSON.stringify({ widget: "veille", block: "tri" }));
    h.rpc.notify("agent.closeWindow", { window: "w1" });
    await until(() => !existsSync(first));
    expect((await callMcpTool(h.root, "open_workflow", {}, await session())).text).toBe(NO_WORKFLOW_OPEN);
  });

  it("workflow.* answer a bad input with the UI's shapes", async () => {
    const h = startHost();
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
        navigate: ([, url]: [string, string]) => void navigations.push(url),
        "sites.openIds": () => ["vidola"],
      },
    });
    await h.rpc.request("start", { agentProfile: "claude" });
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
    await h.rpc.request("start", { agentProfile: "claude" });
    h.child.stdin.end();
    expect(await h.exited).toBe(0);
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

  it("search_history finds a non-private visit, never a private one", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude" });
    visit(h, "https://a.test/", "Alpha");
    visit(h, "https://b.test/", "Alpha privé", { private: true });
    await settle(h);
    const r = await callMcpTool(h.root, "search_history", { query: "alpha" });
    expect(r.text).toContain("a.test");
    expect(r.text).not.toContain("b.test");
    expect((await callMcpTool(h.root, "read_history", { url: "https://a.test/" })).text).toBe("Rien de retenu pour cette page.");
  });

  it("retained text is found by the agent, never for a loopback URL", async () => {
    const h = startHost();
    await h.rpc.request("start", { agentProfile: "claude" });
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
    await h.rpc.request("start", { agentProfile: "claude" });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    expect(h.stderr()).toContain("history");
  });

  it("a space turned private marks its visits", async () => {
    const h = startHost();
    visit(h, "https://a.test/", "Page A");
    h.rpc.notify("history.makePrivate", { spaceId: "e1" });
    await settle(h);
    expect(await h.rpc.request("history.recent", {})).toEqual([expect.objectContaining({ spaceId: "e1", private: true })]);
  });
});

describe("agent extensions", { timeout: 60_000 }, () => {
  const HOST = "http://127.0.0.1/*";
  const GRANT = { permissions: [], hosts: [HOST], network: [], allSites: false, allSitesScripts: false, scripts: true };
  const ID = "ma-ext@agent.webaios";
  const amos: Awaited<ReturnType<typeof startFakeAmo>>[] = [];
  afterEach(async () => {
    for (const a of amos.splice(0)) await a.close();
  });
  const fakeAmo = async (o?: Parameters<typeof startFakeAmo>[0]) => {
    const a = await startFakeAmo(o);
    amos.push(a);
    return a;
  };

  /** The agent's source in `<dataDir>/workspace/extensions/ma-ext`: a classic service worker and a content script CSS. */
  const source = (dataDir: string, o: { hosts?: string[]; css?: string } = {}) => {
    const dir = join(dataDir, "workspace", "extensions", "ma-ext");
    mkdirSync(dir, { recursive: true });
    const manifest = { manifest_version: 3, name: "Cacheur", version: "1.0.0", background: { service_worker: "fond.js" }, content_scripts: [{ matches: o.hosts ?? [HOST], css: ["cache.css"] }] };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "fond.js"), "console.log('fond');\n");
    writeFileSync(join(dir, "cache.css"), o.css ?? "#cache-moi { display: none }\n");
  };
  const grant = (dataDir: string, profiles = ["default"], grant: unknown = GRANT) => {
    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    const entry = { source: "agent", addonId: null, name: "Cacheur", version: "1.0.0", grant: grant, profiles: profiles, pinned: false, modifiedAt: null, disabled: null, pendingUpdate: null, seenVersions: {} };
    writeFileSync(join(dataDir, "extensions", "state.json"), JSON.stringify({ version: 1, allCut: false, extensions: { "agent:ma-ext": entry } }));
  };
  const entry = (dataDir: string) => (JSON.parse(readFileSync(join(dataDir, "extensions", "state.json"), "utf8")) as { extensions: Record<string, any> }).extensions["agent:ma-ext"];

  /**
   * Firefox's side, as the chrome does it: an inactive add-on is never installed fresh, the same version is not
   * reinstalled. Notes each real install (with the .xpi's hash and manifest, read before the kernel moves it), every
   * installer call, activation and uninstall. `casse`: installs throw.
   */
  const firefox = () => {
    const installs: { addonId: string; version: string; temporary: boolean; sha: string; manifest: any }[] = [];
    const calls: { version: string; active: boolean }[] = [];
    const activations: { addonId: string; active: boolean }[] = [];
    const uninstalls: string[] = [];
    const present = new Map<string, string>();
    const f = {
      installs,
      calls: calls,
      activations,
      uninstalls: uninstalls,
      presents: present,
      broken: false,
      spaces: [{ id: "e1", name: "Perso", profile: "default", private: false }] as { id: string; name: string; profile: string; private: boolean }[],
      /** The grant cards asked, and the answer given to each (default: Activer). */
      cards: [] as ExtensionCard[],
      /** Every extensions.portees notification, in order. */
      scopes: [] as Record<string, unknown>[],
      /** Every extensions.rechargerOnglets notification. */
      reloads: [] as unknown[],
      /** Every extensions.redemarrer request (an unchanged reload). */
      restarts: [] as string[],
      answer: (c: ExtensionCard): GrantResponse => ({ accepted: true, hash: c.hash }),
      handlers: {} as Record<string, Handler>,
    };
    f.handlers = {
      "extensions.install": (p: { addonId: string; xpi: string; temporary: boolean; version: string; active: boolean }) => {
        calls.push({ version: p.version, active: p.active });
        if ((!p.active && !present.has(p.addonId)) || present.get(p.addonId) === p.version) return null;
        if (f.broken) throw new Error("boom");
        const manifest = JSON.parse(execFileSync("unzip", ["-p", p.xpi, "manifest.json"]).toString());
        installs.push({ addonId: p.addonId, version: p.version, temporary: p.temporary, sha: createHash("sha256").update(readFileSync(p.xpi)).digest("hex"), manifest: manifest });
        present.set(p.addonId, p.version);
        return { version: p.version };
      },
      "extensions.enable": (p: { addonId: string; active: boolean }) => void activations.push(p),
      "extensions.restart": (p: { addonId: string }) => void f.restarts.push(p.addonId),
      "extensions.uninstall": (p: { addonId: string }) => void (uninstalls.push(p.addonId), present.delete(p.addonId)),
      "extensions.grant": (p: { card: ExtensionCard }) => (f.cards.push(p.card), f.answer(p.card)),
      "browser.spaces": () => ({ spaces: f.spaces, windows: [{ id: "f1", activeSpace: "e1" }], foreground: "f1" }),
      "extensions.scopes": (p: Record<string, unknown>) => void f.scopes.push(p),
      "extensions.reloadTabs": (p: unknown) => void f.reloads.push(p),
      "extensions.amo": () => [{ id: "amo@exemple.org", name: "Module d'AMO", version: "2.0", active: true }],
    };
    return f;
  };

  // Temporary add-ons are gone after a quit.
  // `cles: false`: no AMO keys.
  const launch = (amo: { url: string }, f: ReturnType<typeof firefox>, o: { dataDir?: string; prepare?: (d: string) => void; keys?: false } = {}) => {
    f.presents.clear();
    const keys: Record<string, string> = o.keys === false ? {} : { WEBAIOS_TEST_AMO_KEYS: "user:1:abc:test-secret" };
    return startHost({ WEBAIOS_TEST_AMO_URL: amo.url, ...keys }, o.prepare, { dataDir: o.dataDir, handlers: f.handlers });
  };
  /** An agent tool, once the kernel runs. */
  const tool = async (h: Host, name: string, args: Record<string, unknown> = {}) => {
    await h.rpc.request("start", { agentProfile: "claude" });
    return (await callMcpTool(h.root, name, args)).text;
  };
  const stop = async (h: Host) => {
    await h.rpc.request("stop");
    await h.exited;
  };
  const prepare = (d: string) => (source(d), grant(d));

  it("a granted extension is copied, signed, installed; restart with an unchanged source sends nothing", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    let h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.ready", {});
    expect(amo.sends.map((e) => [e.guid, e.version])).toEqual([[ID, "1.0.0.1"]]);
    expect(f.installs).toEqual([expect.objectContaining({ addonId: ID, version: "1.0.0.1", temporary: true })]);
    expect(f.activations).toEqual([{ addonId: ID, active: true }]);
    expect(entry(h.dataDir)).toMatchObject({ addonId: ID, grant: GRANT, disabled: null });
    // Sent first at startup (before the install), then after each registry change.
    const scope = { [ID]: { key: "agent:ma-ext", grant: GRANT, profiles: ["default"], active: true } };
    expect(f.scopes[0]).toEqual(scope);
    expect(f.scopes.at(-1)).toEqual(scope);
    await stop(h);

    h = launch(amo, f, { dataDir: h.dataDir });
    await h.rpc.request("extensions.ready", {});
    expect(amo.sends).toHaveLength(1);
    expect(f.installs).toHaveLength(2);
    expect(f.installs[1]).toMatchObject({ version: "1.0.0.1", sha: f.installs[0]!.sha });
  });

  it("a classic service_worker background becomes background.scripts [guard, original] in the signed copy", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.ready", {});
    expect(f.installs[0]!.manifest.background).toEqual({ scripts: ["webaios-background-guard.js", "fond.js"] });
    expect(f.installs[0]!.manifest.browser_specific_settings.gecko.id).toBe(ID);
  });

  it("source changed while closed: signed again at startup; a new site disables it, grant kept", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    let h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.ready", {});
    await stop(h);
    source(h.dataDir, { css: "#cache-moi, #reste { display: none }\n" });
    h = launch(amo, f, { dataDir: h.dataDir });
    await h.rpc.request("extensions.ready", {});
    expect(f.installs.map((i) => i.version)).toEqual(["1.0.0.1", "1.0.0.2"]);
    expect(entry(h.dataDir).disabled).toBeNull();
    await stop(h);

    source(h.dataDir, { hosts: [HOST, "https://exemple.com/*"] });
    f.activations.length = 0;
    h = launch(amo, f, { dataDir: h.dataDir });
    await h.rpc.request("extensions.ready", {});
    expect(amo.sends).toHaveLength(2);
    expect(f.installs).toHaveLength(2);
    expect(entry(h.dataDir)).toMatchObject({ grant: GRANT, disabled: { reason: "scope-widened" } });
    expect(f.activations).toEqual([{ addonId: ID, active: false }]);
  });

  it("two reloads in a row: serialized; the second, unchanged, restarts the add-on without sending anything", async () => {
    const amo = await fakeAmo({ delayMs: 500 });
    const f = firefox();
    const h = launch(amo, f, { prepare });
    await h.rpc.request("start", { agentProfile: "claude" });
    const [a, b] = await Promise.all([tool(h, "reload_extension", { id: "ma-ext" }), tool(h, "reload_extension", { id: "ma-ext" })]);
    expect([a, b]).toEqual(["state : reloaded", "state : reloaded"]);
    expect(amo.sends.map((e) => e.version)).toEqual(["1.0.0.1"]);
    expect(f.restarts).toEqual([ID]);
    // Changed again: signed again, the next number.
    source(h.dataDir, { css: "#autre { display: none }\n" });
    expect(await tool(h, "reload_extension", { id: "ma-ext" })).toBe("state : reloaded");
    expect(amo.sends.map((e) => e.version)).toEqual(["1.0.0.1", "1.0.0.2"]);
    expect(f.installs.at(-1)!.version).toBe("1.0.0.2");
    expect(JSON.parse(readFileSync(join(h.dataDir, "extensions", "signed", "ma-ext.json"), "utf8")).version).toBe("1.0.0.2");
  });

  it("a failed signature leaves the running version", async () => {
    const f = firefox();
    let h = launch(await fakeAmo(), f, { prepare });
    await h.rpc.request("extensions.ready", {});
    await stop(h);
    source(h.dataDir, { css: "#reste { display: none }\n" });
    h = launch(await fakeAmo({ denial: "Validation failed: eval" }), f, { dataDir: h.dataDir });
    const r = await tool(h, "reload_extension", { id: "ma-ext" });
    expect(r).toContain("state : refused");
    expect(r).toContain(deniedSignature("Validation failed: eval"));
    expect(r).not.toContain("test-secret");
    expect(JSON.parse(readFileSync(join(h.dataDir, "extensions", "signed", "ma-ext.json"), "utf8")).version).toBe("1.0.0.1");
    expect(f.installs).toHaveLength(1);
    expect(existsSync(join(h.dataDir, "extensions", "signed", "ma-ext.xpi"))).toBe(true);
  });

  it("removed from about:addons: grant deleted, never reinstalled", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    let h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.ready", {});
    h.rpc.notify("extensions.outsideWebaios", { addonId: ID, what: "uninstalled" });
    await until(() => entry(h.dataDir) === undefined);
    await until(() => JSON.stringify(f.scopes.at(-1)) === "{}");
    expect(existsSync(join(h.dataDir, "extensions", "signed", "ma-ext.xpi"))).toBe(false);
    await stop(h);
    h = launch(amo, f, { dataDir: h.dataDir });
    await h.rpc.request("extensions.ready", {});
    expect(f.installs).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(h.dataDir, "extensions", "amo-versions.json"), "utf8"))).toEqual({ "ma-ext": 1 });
  });

  it("removed from about:addons, then undone there before the removal ran: the grant stays", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const requests: unknown[] = [];
    // The chrome finds the add-on no longer pending uninstall (Undo): it keeps it and answers false.
    f.handlers["extensions.uninstall"] = (p: unknown) => (requests.push(p), false);
    const h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.ready", {});
    await h.rpc.request("extensions.outsideWebaios", { addonId: ID, what: "uninstalled" });
    expect(requests).toEqual([{ addonId: ID, unlessUndone: true }]);
    expect(entry(h.dataDir)).toMatchObject({ grant: GRANT, profiles: ["default"] });
    expect(existsSync(join(h.dataDir, "extensions", "signed", "ma-ext.xpi"))).toBe(true);
  });

  it("source changed while closed, active nowhere: nothing sent at startup, signed when next activated", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    let h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.ready", {});
    await stop(h);
    grant(h.dataDir, []);
    source(h.dataDir, { css: "#cache-moi, #reste { display: none }\n" });
    h = launch(amo, f, { dataDir: h.dataDir });
    await h.rpc.request("extensions.ready", {});
    expect(amo.sends.map((e) => e.version)).toEqual(["1.0.0.1"]);
    expect(await h.rpc.request("extensions.toggle", { key: "agent:ma-ext", spaceId: "e1", active: true, window: null })).toEqual({ ok: true });
    expect(amo.sends.map((e) => e.version)).toEqual(["1.0.0.1", "1.0.0.2"]);
    expect(f.installs.at(-1)).toMatchObject({ version: "1.0.0.2" });
    expect(f.activations.at(-1)).toEqual({ addonId: ID, active: true });
  });

  it("aTourne: an unreadable tab masks its console in that profile and by add-on id, once; a readable one changes nothing", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.ready", {});
    const registry = () => JSON.parse(readFileSync(join(h.dataDir, "extensions", "state.json"), "utf8"));
    await h.rpc.request("extensions.ran", { addonId: ID, profile: "default", readable: true });
    expect(entry(h.dataDir)?.hiddenConsole).toBeUndefined();
    for (let i = 0; i < 2; i++) await h.rpc.request("extensions.ran", { addonId: ID, profile: "default", readable: false });
    await h.rpc.request("extensions.ran", { addonId: "autre@mozilla.org", profile: "default", readable: false });
    expect(entry(h.dataDir)?.hiddenConsole).toEqual(["default"]);
    expect(registry().hiddenConsoles).toEqual([ID]);
    // Never emptied: it outlives « Supprimer ».
    h.rpc.notify("extensions.outsideWebaios", { addonId: ID, what: "uninstalled" });
    await until(() => entry(h.dataDir) === undefined);
    expect(registry().hiddenConsoles).toEqual([ID]);
  });

  it("console: content-script messages from unreadable tabs are counted, background masked once it ran there", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    // No site nor observing right: its background's console shows until it runs in a tab the agent cannot read.
    const h = launch(amo, f, { prepare: (d) => grant(d, ["default"], { ...GRANT, hosts: [], scripts: false }) });
    await h.rpc.request("start", { agentProfile: "claude" });
    const m = (text: string) => ({ timestamp: Date.now(), level: "log", text: text });
    h.rpc.notify("extensions.console", { addonId: ID, message: m("fond démarré"), tab: null });
    // The user gives t1 to the agent; t2 is not shared; null: no WebAiOs tab (a reading, a private space).
    await h.rpc.request("agent.send", { tab: tabs[0] });
    h.rpc.notify("extensions.console", { addonId: ID, message: m("contenu:/a.html"), tab: { tabId: "t2", url: tabs[1]!.url } });
    h.rpc.notify("extensions.console", { addonId: ID, message: m("contenu:/lecture"), tab: { tabId: null, url: "" } });
    h.rpc.notify("extensions.console", { addonId: ID, message: m("contenu:/b.html"), tab: { tabId: "t1", url: tabs[0]!.url } });
    let t = await tool(h, "extension_console", { id: "ma-ext" });
    expect(t).toContain("fond démarré");
    expect(t).toContain("contenu:/b.html");
    expect(t).not.toContain("contenu:/a.html");
    expect(t).not.toContain("contenu:/lecture");
    expect(t).toContain(hiddenTabs(2));
    expect(t).not.toContain(CONSOLE_BACKGROUND_HIDDEN);
    await h.rpc.request("extensions.ran", { addonId: ID, profile: "default", readable: false });
    t = await tool(h, "extension_console", { id: "agent:ma-ext" });
    expect(t).toContain(CONSOLE_BACKGROUND_HIDDEN);
    expect(t).not.toContain("fond démarré");
    expect(t).toContain("contenu:/b.html");
  });

  it("unlock_console: the card names the spaces; granted, nothing masked until lock_console or a reload", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const requests: unknown[] = [];
    let outcome = "allow";
    f.handlers["extensions.unlock"] = (p: unknown) => (requests.push(p), outcome);
    const h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.ready", {});
    h.rpc.notify("extensions.console", { addonId: ID, message: { timestamp: Date.now(), level: "log", text: "fond démarré" }, tab: null });
    // A site: its background is always masked (observing right).
    expect(await tool(h, "extension_console", { id: "ma-ext" })).toContain(OBSERVED_BACKGROUND_CONSOLE);
    expect(await tool(h, "unlock_console", { id: "ma-ext", reason: "r".repeat(300) })).toContain("Console débloquée");
    expect(requests).toEqual([{ name: "Cacheur", spaces: ["Perso"], reason: "r".repeat(200), agent: expect.any(String), window: null }]);
    let t = await tool(h, "extension_console", { id: "ma-ext" });
    expect(t).toContain("fond démarré");
    expect(t).toContain(CONSOLE_UNLOCKED);
    expect(await tool(h, "lock_console", { id: "ma-ext" })).toContain("refermée");
    expect(await tool(h, "extension_console", { id: "ma-ext" })).toContain(OBSERVED_BACKGROUND_CONSOLE);
    // Unlocked again, then reloaded (a new copy): masked again.
    await tool(h, "unlock_console", { id: "ma-ext", reason: "r" });
    expect(await tool(h, "reload_extension", { id: "ma-ext" })).toBe("state : reloaded");
    t = await tool(h, "extension_console", { id: "ma-ext" });
    expect(t).not.toContain("fond démarré");
    expect(t).toContain(OBSERVED_BACKGROUND_CONSOLE);
    // Refused: « Déblocage refusé ».
    outcome = "deny";
    expect(await tool(h, "unlock_console", { id: "ma-ext", reason: "r" })).toBe("Refusée par l'utilisateur.");
  });

  it("a first install of an inactive grant never makes the add-on active", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare: (d) => (source(d), grant(d, [])) });
    await h.rpc.request("extensions.ready", {});
    expect(amo.sends).toHaveLength(1);
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls.every((a) => a.active === false)).toBe(true);
    expect(f.installs).toEqual([]);
    expect(f.activations.some((a) => a.active)).toBe(false);
    expect(existsSync(join(h.dataDir, "extensions", "signed", "ma-ext.xpi"))).toBe(true);
  });

  it("a removal seen while the host was down comes with pret: not reinstalled, grant deleted", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.ready", { outsideWebaios: [{ addonId: ID, what: "uninstalled" }] });
    expect(f.installs).toEqual([]);
    expect(amo.sends).toEqual([]);
    expect(entry(h.dataDir)).toBeUndefined();
  });

  it("a failed startup can be retried by a later pret", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    // A directory where the registry should be: reading it throws.
    const h = launch(amo, f, { prepare: (d) => (source(d), mkdirSync(join(d, "extensions", "state.json"), { recursive: true })) });
    await expect(h.rpc.request("extensions.ready", {})).rejects.toThrow();
    rmSync(join(h.dataDir, "extensions", "state.json"), { recursive: true });
    grant(h.dataDir);
    await h.rpc.request("extensions.ready", {});
    expect(f.installs).toHaveLength(1);
  });

  it("a failed install gives a bounded French text and keeps nothing", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    f.broken = true;
    const h = launch(amo, f, { prepare });
    expect(await tool(h, "reload_extension", { id: "ma-ext" })).toContain(installationImpossible("boom"));
    expect(existsSync(join(h.dataDir, "extensions", "signed", "ma-ext.json"))).toBe(false);
  });

  it("extensions.profilsPrives: the profile leaves the grant, its tabs reloaded, the add-on disabled; a profile not in use changes nothing", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.ready", {});
    h.rpc.notify("extensions.privateProfiles", { profiles: ["autre"] });
    f.spaces[0]!.private = true;
    h.rpc.notify("extensions.privateProfiles", { profiles: ["default"] });
    await until(() => f.activations.at(-1)?.active === false);
    expect(entry(h.dataDir).profiles).toEqual([]);
    expect(f.reloads).toEqual([{ addonId: ID, profiles: ["default"] }]);
  });

  it("pourEspace and basculer: the space's lines; off then on in the same profile, at once; refused in a private one", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    f.spaces.push({ id: "e2", name: "Lecture", profile: "default", private: false }, { id: "e3", name: "Secret", profile: "secret", private: true });
    const h = launch(amo, f, { prepare: (d) => (prepare(d), mkdirSync(join(d, "workspace", "extensions", "jamais"), { recursive: true })) });
    await h.rpc.request("extensions.ready", {});
    const line = { key: "agent:ma-ext", name: "Cacheur", source: "agent", active: true, alsoIn: ["Lecture"], greyedOut: null, profiles: ["default"] };
    const never = { key: "agent:jamais", name: "jamais", source: "agent", active: false, alsoIn: [], greyedOut: null, profiles: [] };
    expect(await h.rpc.request("extensions.forSpace", { spaceId: "e1" })).toEqual([line, never]);
    expect(await h.rpc.request("extensions.forSpace", { spaceId: "e3" })).toEqual([
      { ...line, active: false, alsoIn: [], greyedOut: PRIVATE_PROFILE_ERROR },
      { ...never, greyedOut: PRIVATE_PROFILE_ERROR },
    ]);
    expect(await h.rpc.request("extensions.toggle", { key: "agent:ma-ext", spaceId: "e3", active: true })).toEqual({ ok: false, error: PRIVATE_PROFILE_ERROR });
    expect(await h.rpc.request("extensions.toggle", { key: "agent:ma-ext", spaceId: "e1", active: false })).toEqual({ ok: true });
    expect(entry(h.dataDir).profiles).toEqual([]);
    expect(f.activations.at(-1)).toEqual({ addonId: ID, active: false });
    expect(await h.rpc.request("extensions.toggle", { key: "agent:ma-ext", spaceId: "e2", active: true })).toEqual({ ok: true });
    expect(entry(h.dataDir).profiles).toEqual(["default"]);
    expect(f.activations.at(-1)).toEqual({ addonId: ID, active: true });
    expect(f.cards).toEqual([]);
    // Never granted: through its card.
    f.answer = (c) => ({ accepted: false, hash: c.hash });
    expect(await h.rpc.request("extensions.toggle", { key: "agent:jamais", spaceId: "e1", active: true })).toMatchObject({ ok: false });
  });

  it("a profile used by a private space is taken out of the grant's profiles", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    f.spaces.push({ id: "e2", name: "Secret", profile: "secret", private: true });
    const h = launch(amo, f, { prepare: (d) => (source(d), grant(d, ["default", "secret"])) });
    await h.rpc.request("extensions.ready", {});
    expect(entry(h.dataDir).profiles).toEqual(["default"]);
  });

  it("request_extension: refused, nothing sent; Activer: signed and installed, then granted, « Activée »", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    // Nothing granted while the card shows, nor while it installs: the grant is written after the install.
    const grant = f.handlers["extensions.grant"]!;
    const install = f.handlers["extensions.install"]!;
    const withoutGrant: boolean[] = [];
    const notGranted = () => !existsSync(join(h.dataDir, "extensions", "state.json")) || !entry(h.dataDir)?.grant;
    f.handlers["extensions.grant"] = (p, s) => (withoutGrant.push(notGranted()), grant(p, s));
    f.handlers["extensions.install"] = (p, s) => (withoutGrant.push(notGranted()), install(p, s));
    const h = launch(amo, f, { prepare: source });
    f.answer = (c) => ({ accepted: false, hash: c.hash });
    expect(await tool(h, "request_extension", { id: "ma-ext" })).toBe("Refusée par l'utilisateur.");
    expect(amo.sends).toEqual([]);
    f.answer = (c) => ({ accepted: true, hash: c.hash });
    expect(await tool(h, "request_extension", { id: "ma-ext" })).toBe("Activée dans « Perso ».");
    expect(f.cards[1]).toMatchObject({ key: "agent:ma-ext", name: "Cacheur", space: "Perso", spaceId: "e1", sites: [HOST], network: [] });
    expect(f.installs).toEqual([expect.objectContaining({ version: "1.0.0.1" })]);
    // Two cards, the signed install; then appliquer's call (same version: a no-op) once granted.
    expect(withoutGrant).toEqual([true, true, true, false]);
    expect(entry(h.dataDir)).toMatchObject({ addonId: ID, grant: GRANT, profiles: ["default"], disabled: null });
    expect(f.activations.at(-1)).toEqual({ addonId: ID, active: true });
    // Already granted and active there: nothing asked again.
    expect(await tool(h, "request_extension", { id: "ma-ext" })).toBe("Activée dans « Perso ».");
    expect(f.cards).toHaveLength(2);
    const list = await tool(h, "list_extensions");
    expect(list).toContain("agent:ma-ext · Cacheur · 1.0.0 · agent · actives dans : Perso · erreurs : aucune");
    // Then Firefox's AMO add-ons, global (decision 7).
    expect(list).toMatch(/agent:ma-ext .*\nstore:amo@exemple\.org · Module d'AMO · 2\.0 · store · actives dans : Perso · erreurs : aucune$/);
  });

  it("request_extension without AMO keys: clear error, no card asked, nothing sent", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare: source, keys: false });
    const r = await tool(h, "request_extension", { id: "ma-ext" });
    expect(r).toContain("Clés AMO absentes");
    expect(r).toBe(KEYS_ABSENT);
    expect(f.cards).toEqual([]);
    expect(amo.sends).toEqual([]);
  });

  it("nativeMessaging is refused by the copy, before any card", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, {
      prepare: (d) => {
        source(d);
        const path = join(d, "workspace", "extensions", "ma-ext", "manifest.json");
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), permissions: ["nativeMessaging"] }));
      },
    });
    expect(await tool(h, "request_extension", { id: "ma-ext" })).toContain("Droit refusé : nativeMessaging");
    expect(f.cards).toEqual([]);
    expect(amo.sends).toEqual([]);
  });

  it("reload_extension: a new site disables it (grant kept), the card comes back", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare: source });
    expect(await tool(h, "request_extension", { id: "ma-ext" })).toBe("Activée dans « Perso ».");
    source(h.dataDir, { hosts: [HOST, "https://exemple.com/*"] });
    const r = await tool(h, "reload_extension", { id: "ma-ext" });
    expect(r).toContain("state : disabled");
    expect(r).toContain("request_extension");
    expect(entry(h.dataDir)).toMatchObject({ grant: GRANT, disabled: { reason: "scope-widened" } });
    expect(f.activations.at(-1)).toEqual({ addonId: ID, active: false });
    expect(await tool(h, "request_extension", { id: "ma-ext" })).toBe("Activée dans « Perso ».");
    expect(f.cards).toHaveLength(2);
    expect(entry(h.dataDir)).toMatchObject({ grant: { hosts: [HOST, "https://exemple.com/*"] }, disabled: null });
    expect(f.installs.map((i) => i.version)).toEqual(["1.0.0.1", "1.0.0.2"]);
    expect(f.activations.at(-1)).toEqual({ addonId: ID, active: true });
  });

  it("list_extensions gives an agent extension's console errors, filtered as extension_console; an AMO listing failure keeps the agent rows", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    f.handlers["extensions.amo"] = () => {
      throw new Error("AddonManager absent");
    };
    const h = launch(amo, f, { prepare: (d) => grant(d, ["default"], { ...GRANT, hosts: [], scripts: false }) });
    await h.rpc.request("start", { agentProfile: "claude" });
    const m = (text: string) => ({ timestamp: Date.now(), level: "error", text: text });
    h.rpc.notify("extensions.console", { addonId: ID, message: m("fond cassé"), tab: null });
    // From a tab the agent cannot read: never in its list.
    h.rpc.notify("extensions.console", { addonId: ID, message: m("contenu cassé"), tab: { tabId: "t2", url: tabs[1]!.url } });
    const t = await tool(h, "list_extensions");
    expect(t).toContain("agent:ma-ext · Cacheur · 1.0.0 · agent · actives dans : Perso · erreurs : fond cassé");
    expect(t).not.toContain("contenu cassé");
  });

  it("a refused reload is kept as the extension's error (list_extensions and the page) until a reload passes", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare: source });
    expect(await tool(h, "request_extension", { id: "ma-ext" })).toBe("Activée dans « Perso ».");
    const path = join(h.dataDir, "workspace", "extensions", "ma-ext", "manifest.json");
    const before = readFileSync(path, "utf8");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(before), permissions: ["nativeMessaging"] }));
    expect(await tool(h, "reload_extension", { id: "ma-ext" })).toContain("state : refused");
    expect(await tool(h, "list_extensions")).toContain("erreurs : Droit refusé : nativeMessaging");
    const page = await h.rpc.request<{ errors: string[] }[]>("extensions.list");
    expect(page[0]!.errors.join()).toContain("Droit refusé : nativeMessaging");
    writeFileSync(path, before);
    expect(await tool(h, "reload_extension", { id: "ma-ext" })).toBe("state : reloaded");
    expect(await tool(h, "list_extensions")).toContain("erreurs : aucune");
  });

  it("revoir: nothing to review within the grant; disabled for a broadened scope, the card comes back in the window's space", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare: source });
    expect(await tool(h, "request_extension", { id: "ma-ext" })).toBe("Activée dans « Perso ».");
    expect(await h.rpc.request("extensions.review", { key: "agent:ma-ext", window: "f1" })).toEqual({ ok: false, error: NOTHING_TO_REVIEW });
    source(h.dataDir, { hosts: [HOST, "https://exemple.com/*"] });
    expect(await tool(h, "reload_extension", { id: "ma-ext" })).toContain("state : disabled");
    expect(await h.rpc.request("extensions.review", { key: "agent:ma-ext", window: "f1" })).toEqual({ ok: true });
    expect(f.cards).toHaveLength(2);
    expect(f.cards[1]).toMatchObject({ spaceId: "e1", sites: [HOST, "https://exemple.com/*"] });
    expect(entry(h.dataDir)).toMatchObject({ grant: { hosts: [HOST, "https://exemple.com/*"] }, disabled: null });
    expect(f.activations.at(-1)).toEqual({ addonId: ID, active: true });
  });

  it("a space made private during the signing: error, the broader version does not run under the narrower grant", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    f.spaces.push({ id: "e2", name: "Travail", profile: "travail", private: false });
    const install = f.handlers["extensions.install"]!;
    // Turns Travail private as the broader version (1.0.0.2) is installed.
    f.handlers["extensions.install"] = (p, s) => {
      if (p.version === "1.0.0.2") f.spaces[1]!.private = true;
      return install(p, s);
    };
    const h = launch(amo, f, { prepare });
    await h.rpc.request("extensions.ready", {});
    source(h.dataDir, { hosts: [HOST, "https://exemple.com/*"] });
    expect(await tool(h, "request_extension", { id: "ma-ext", space: "Travail" })).toBe(PRIVATE_PROFILE_ERROR);
    expect(entry(h.dataDir)).toMatchObject({ grant: GRANT, profiles: ["default"], disabled: { reason: "scope-widened" } });
    expect(f.activations.at(-1)).toEqual({ addonId: ID, active: false });
  });

  it("a space deleted during the signing: error, nothing granted, the add-on removed", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    f.spaces.push({ id: "e2", name: "Travail", profile: "travail", private: false });
    const install = f.handlers["extensions.install"]!;
    f.handlers["extensions.install"] = (p, s) => {
      f.spaces.splice(1);
      return install(p, s);
    };
    const h = launch(amo, f, { prepare: source });
    expect(await tool(h, "request_extension", { id: "ma-ext", space: "Travail" })).toBe("Espace disparu pendant la carte : rien n'est activé");
    expect(existsSync(join(h.dataDir, "extensions", "state.json")) && entry(h.dataDir)).toBeFalsy();
    expect(f.uninstalls).toEqual([ID]);
  });

  it("a new conversation drops the card: « retirée », nothing sent, no grant", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    f.handlers["extensions.grant"] = (p: { card: ExtensionCard }, signal) => {
      f.cards.push(p.card);
      return new Promise((r) => signal.addEventListener("abort", () => r({ accepted: true, hash: p.card.hash })));
    };
    const h = launch(amo, f, { prepare: source });
    const call = tool(h, "request_extension", { id: "ma-ext" });
    await until(() => f.cards.length === 1);
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    expect(await call).toBe(REQUEST_REMOVED);
    expect(amo.sends).toEqual([]);
    expect(existsSync(join(h.dataDir, "extensions", "state.json")) && entry(h.dataDir)).toBeFalsy();
    expect(existsSync(join(h.dataDir, "extensions", "copies", "ma-ext.attente"))).toBe(false);
  });
  it("three crashes in a minute disable it everywhere; Réactiver brings it back", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare: source });
    expect(await tool(h, "request_extension", { id: "ma-ext" })).toBe("Activée dans « Perso ».");
    // Not an agent extension, or not one of its keys: never counted.
    for (const addonId of ["autre@exemple.org", "../x@agent.webaios", 3]) h.rpc.notify("extensions.crash", { addonId });
    for (let i = 0; i < 2; i++) h.rpc.notify("extensions.crash", { addonId: ID });
    expect(await tool(h, "list_extensions")).toContain("erreurs : aucune");
    h.rpc.notify("extensions.crash", { addonId: ID });
    await until(() => f.activations.at(-1)?.active === false);
    expect(entry(h.dataDir)).toMatchObject({ profiles: ["default"], disabled: { reason: "crashes" } });
    expect(await tool(h, "list_extensions")).toContain(`erreurs : ${DISABLED_CRASHES}`);
    expect((await h.rpc.request<{ disabled: string | null }[]>("extensions.list"))[0]!.disabled).toBe(DISABLED_CRASHES);
    expect(await h.rpc.request("extensions.reenable", { key: "agent:ma-ext" })).toEqual({ ok: true });
    expect(entry(h.dataDir)).toMatchObject({ disabled: null });
    expect(f.activations.at(-1)).toEqual({ addonId: ID, active: true });
    expect(await tool(h, "list_extensions")).toContain("erreurs : aucune");
    // The count starts again: two more crashes do not disable it.
    for (let i = 0; i < 2; i++) h.rpc.notify("extensions.crash", { addonId: ID });
    expect(await tool(h, "list_extensions")).toContain("erreurs : aucune");
  });
  it("crashes seen while no host ran come with extensions.pret, counted at their own time", async () => {
    const amo = await fakeAmo();
    const f = firefox();
    const h = launch(amo, f, { prepare });
    const t = Date.now();
    // Three crashes, but spread over more than a minute: not disabled.
    await h.rpc.request("extensions.ready", { crashes: [-130_000, -50_000, -20_000].map((d) => ({ addonId: ID, at: t + d })) });
    expect(entry(h.dataDir)).toMatchObject({ disabled: null });
    h.rpc.notify("extensions.crash", { addonId: ID, at: t + 1000 });
    await until(() => f.activations.at(-1)?.active === false);
    expect(entry(h.dataDir)).toMatchObject({ disabled: { reason: "crashes" } });
  });
});

describe("agent applications", { timeout: 30_000 }, () => {
  // Their own block, apart from every e2e file's (plans 35a and 35b).
  const APPS = { WEBAIOS_APP_PORTS: "15325-15329", WEBAIOS_APP_DELAY_MS: "3000" };
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
    writeFileSync(join(path, "webaios.json"), JSON.stringify({ type: "app", launch: "node serveur.mjs", name: "Essai" }));
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

  it("lancer asks the chrome to open the app on a port of WEBAIOS_APP_PORTS, and notes dernierLancement", async () => {
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
    expect(stops(h).slice(before.length)).not.toContain("WEBAIOS_APP=essai");
    expect((await attempt(h))?.state).toBe("running");
    h.rpc.notify("apps.windowClosed", { folder: "essai", byUser: true });
    await until(() => stops(h).slice(before.length).includes("WEBAIOS_APP=essai"));
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
    expect(existsSync(join(h.root, "projects", "essai", "webaios.json"))).toBe(true);
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
    await h.rpc.request("start", { agentProfile: "claude" });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    act(h, "debug");
    await until(() => h.data().includes("essai"));
    await until(() => given.length > 0);
    expect(given).toEqual([["f1"]]);
  });

  it("the host stops the apps and the sessions on stdin close", async () => {
    const { h, chrome } = startApps();
    await h.rpc.request("start", { agentProfile: "claude" });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    await launched(h, chrome);
    const before = stops(h).length;
    h.child.stdin.end();
    expect(await h.exited).toBe(0);
    // Started first, then run side by side with the sessions' stop: both happen before the exit.
    const after = stops(h).slice(before);
    expect(after).toContain("WEBAIOS_APP=essai");
    expect(after).toContain("cat /tmp/webaios-session-");
  });

  it("a slow apps stop at quit does not hold back the sessions' stop", async () => {
    const { h, chrome } = startApps({ FAKE_DOCKER_SLOW_APP_STOP: "4" });
    await h.rpc.request("start", { agentProfile: "claude" });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    await launched(h, chrome);
    const before = stops(h).length;
    h.child.stdin.end();
    // The apps' docker answers after 4 s: the sessions are stopped well before.
    await until(() => stops(h).slice(before).includes("cat /tmp/webaios-session-"), 2_500);
    expect(await h.exited).toBe(0);
  });

  it("a failed apps stop at quit still stops the sessions", async () => {
    const { h } = startApps({ WEBAIOS_TEST_APPS_STOP_FAILS: "1" });
    await h.rpc.request("start", { agentProfile: "claude" });
    await h.rpc.request("agent.start", { window: "f1", size: { cols: 80, rows: 24 } });
    await until(() => h.data().includes("fake agent ready>"));
    const before = stops(h).length;
    h.child.stdin.end();
    expect(await h.exited).toBe(0);
    expect(stops(h).slice(before)).toContain("cat /tmp/webaios-session-");
    expect(h.stderr()).toContain("simulated apps stop");
  });

  it("portRange, the app tab and SchemaActionApplication", async () => {
    const { portRange, appTab } = await import("../host/applications");
    const { SchemaActionApplication } = await import("../shared/api");
    expect(portRange("15280-15284")).toEqual([15280, 15284]);
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
