import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer as tcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { SPACE_FOLDER } from "../../../packages/kernel/src/design/external";
import { HOST_STOPPED } from "../chrome/agent/host";
import { failureReason } from "../shared/design-guards";
import { waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { connectClient, declareProject, mcpClient, modified, openApplications, projectDir, rawStatus, readNotifications, textOf, writeAppJs } from "./review";
import { click, inUi, missingApi, waitUi } from "./ui";

// Plan 34 Task 3: the Applications page's « Projets externes » section and
// one test per guarantee of the external MCP server (spec §5.2, §7).

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const dirs: string[] = [];
let w: LaunchedWebAiOs | undefined;
let m: Marionette;
let notifications: string;
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
  }
});
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** WebAiOs on a temporary data folder and profile (kept until the end, to scan them), the Applications page open. */
async function launch(env: Record<string, string> = {}): Promise<LaunchedWebAiOs> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "webaios-notif-"));
  dirs.push(dataDir, profile, outside);
  notifications = path.join(outside, "notifications.jsonl");
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_NOTIFICATIONS: notifications, ...env } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await openApplications(m);
  return w;
}

const tid = (id: string) => `[data-testid="${id}"]`;
const count = (selector: string) => inUi<number>(m, "return doc.querySelectorAll(arguments[0]).length", [selector]);
const waitCount = (selector: string, n: number, ms = 10_000) => waitUi(m, "return doc.querySelectorAll(arguments[0]).length === arguments[1]", [selector, n], ms);
const text = (selector: string) => inUi<string | null>(m, "return doc.querySelector(arguments[0])?.textContent ?? null", [selector]);
const waitText = (selector: string, t: string, ms = 10_000) => waitUi(m, "return doc.querySelector(arguments[0])?.textContent === arguments[1]", [selector, t], ms);
const connectDisabled = () => inUi<boolean | null>(m, "return doc.querySelector('[data-testid=\"brancher-externe\"]')?.disabled ?? null");
const storeEval = <T>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
const hostPid = () => storeEval<number | null>("return store.agent.pid;");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Every file under `dir`. */
function filesOf(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) out.push(...filesOf(p));
    else if (n.isFile()) out.push(p);
  }
  return out;
}

/** The ports the host process listens on (lsof). */
function listeningPorts(pid: number): number[] {
  let out = "";
  try {
    out = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
  } catch {
    // lsof exits 1 when nothing matches.
  }
  return [...out.matchAll(/^n.*:(\d+)$/gm)].map((x) => Number(x[1]));
}

/** A free port on 127.0.0.1, released at once. */
async function freePort(): Promise<number> {
  const s = tcpServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

// externes.spec.ts:50
it("« Brancher un Claude Code »: the command with the real port and a 64-hex token, gone on « Fermer »; clients-externes.json without the token", async () => {
  await launch();
  const { command: command, port, token: token } = await connectClient(m);
  expect(command).toBe(`claude mcp add --transport http --scope user webaios-remarks http://127.0.0.1:${port}/mcp-external --header "Authorization: Bearer ${token}"`);
  expect(port).toBeGreaterThan(0);
  expect(port).not.toBe(5279);
  await waitCount(tid("client-externe"), 1);
  expect(await text(tid("client-externe"))).toContain("Claude Code");
  const file = path.join(w!.dataDir, "design", "clients-externes.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const content = readFileSync(file, "utf8");
  expect(content).toContain(sha256(token));
  expect(content).not.toContain(token);
  await click(m, tid("fermer-commande"));
  await waitCount(tid("commande-branchement"), 0);
  expect(await inUi<string>(m, "return doc.body.textContent")).not.toContain(token);
});

// externes.spec.ts:76
it("declare_project: the projet-externe line shows; one notification only, even after a second declaration", async () => {
  await launch();
  const folder = projectDir("mon-site");
  const { port, token: token } = await connectClient(m);
  const c = await mcpClient(port, token);
  try {
    const r = await c.callTool({ name: "declare_project", arguments: { folder: folder, ports: [18765] } });
    expect(textOf(r)).toContain("mon-site");
    await waitCount(tid("projet-externe"), 1);
    const line = (await text(tid("projet-externe")))!;
    for (const t of ["mon-site", folder, "18765", "Claude Code"]) expect(line).toContain(t);
    await expect.poll(() => readNotifications(notifications), { timeout: 10_000 }).toEqual([{ title: "WebAiOs", text: "Claude Code a branché le projet mon-site" }]);
    await c.callTool({ name: "declare_project", arguments: { folder: folder, ports: [18765] } });
    await new Promise((r) => setTimeout(r, 500));
    expect(readNotifications(notifications)).toHaveLength(1);
    expect(await count(tid("projet-externe"))).toBe(1);
  } finally {
    await c.close();
  }
});

// externes.spec.ts:209 (the section's part)
it("Révoquer: the next call returns 401; the project line says « aucun client »", async () => {
  await launch();
  const p = await declareProject(m, { dataDir: w!.dataDir });
  try {
    await click(m, `${tid("client-externe")} button`, { text: "Révoquer" });
    await waitCount(tid("client-externe"), 0);
    await expect(p.client.callTool({ name: "read_remarks", arguments: { folder: p.folder } })).rejects.toMatchObject({ code: 401 });
    await waitUi(m, "return doc.querySelector('[data-testid=\"projet-externe\"]')?.textContent.includes('aucun client')");
  } finally {
    await p.client.close();
  }
});

// externes.spec.ts:230 (the section's part; the ✎ button is plan 35's)
it("Oublier: the line goes, with ext-<id>.git and its comments under <dataDir>/design/relecture/", async () => {
  await launch();
  const p = await declareProject(m, { dataDir: w!.dataDir });
  try {
    // A comment on the project (the Review page is Task 4's: straight through the host).
    writeAppJs(p.folder, modified(2));
    const project = `ext-${p.id}`;
    const r = await storeEval<{ ok: boolean }>(
      `const v = await store.agent.request("relecture.ouvrir", { projet: arguments[0] });
       return store.agent.request("relecture.commenter", { projet: arguments[0], jeton: v.jeton, c: { fichier: "app.js", debut: 2, fin: 2, texte: "Plus court" } });`,
      [project],
    );
    expect(r.ok).toBe(true);
    const review = path.join(w!.dataDir, "design", "relecture");
    const comments = path.join(review, `${project}.commentaires.json`);
    expect(existsSync(comments)).toBe(true);
    await click(m, `${tid("projet-externe")} button`, { text: "Oublier" });
    await waitCount(tid("projet-externe"), 0);
    await expect.poll(() => existsSync(path.join(review, `${project}.git`)) || existsSync(comments), { timeout: 10_000 }).toBe(false);
  } finally {
    await p.client.close();
  }
});

// externes.spec.ts:279
it("a port held elsewhere: the section says so, « Brancher » is greyed, and nothing listens on another port", async () => {
  const held = tcpServer();
  await new Promise<void>((ok) => held.listen(0, "127.0.0.1", ok));
  const port = (held.address() as { port: number }).port;
  try {
    await launch({ WEBAIOS_PORT_MCP_EXTERNAL: String(port) });
    await waitText(tid("raison-externes"), `Le port ${port} est pris : le MCP externe est éteint.`, 15_000);
    expect(await connectDisabled()).toBe(true);
    // No fallback: no port of the host answers like the external server (Origin → 403 before any token, as the
    // kernel's own server answers 401).
    const pid = (await waitFor<number | null>(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`, (v) => v !== null))!;
    const ports = listeningPorts(pid);
    // The kernel MCP server at least: lsof does see the host's sockets.
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) {
      const host = `127.0.0.1:${p}`;
      const statuses = [await rawStatus(p, { Host: host, Origin: "http://evil.test" }), await rawStatus(p, { Host: `evil.localhost:${p}` }), await rawStatus(p, { Host: host })];
      expect(statuses, `port ${p}`).not.toEqual([403, 403, 401]);
    }
  } finally {
    await new Promise<void>((ok) => held.close(() => ok()));
  }
});

// externes.spec.ts:296
it("an invalid port (WEBAIOS_PORT_MCP_EXTERNAL=abc): the section says the external MCP could not start", async () => {
  await launch({ WEBAIOS_PORT_MCP_EXTERNAL: "abc" });
  await waitUi(m, "return doc.querySelector('[data-testid=\"raison-externes\"]')?.textContent.startsWith(arguments[0])", ["Le MCP externe n'a pas pu démarrer : "], 15_000);
  expect(await connectDisabled()).toBe(true);
});

it("a foreign Host, an Origin header, no token, the kernel's main token and a session token are refused", { timeout: 90_000 }, async () => {
  await launch();
  const { port } = await connectClient(m);
  const host = `127.0.0.1:${port}`;
  expect(await rawStatus(port, { Host: `evil.localhost:${port}` })).toBe(403);
  expect(await rawStatus(port, { Host: host, Origin: `http://127.0.0.1:${port}` })).toBe(403);
  expect(await rawStatus(port, { Host: host })).toBe(401);
  const space = path.join(w!.dataDir, "espace");
  const auth = (config: string) => JSON.parse(readFileSync(config, "utf8")).mcpServers.webaios.headers.Authorization as string;
  const mainConfig = path.join(space, ".webaios", "mcp.json");
  await expect.poll(() => existsSync(mainConfig), { timeout: 20_000 }).toBe(true);
  expect(await rawStatus(port, { Host: host, Authorization: auth(mainConfig) })).toBe(401);
  // The open agent panel's session (as agent-panel.e2e.ts:73): its config path, /workspace being <dataDir>/espace.
  const args = path.join(space, "faux-agent-args.json");
  await expect.poll(() => existsSync(args), { timeout: 20_000 }).toBe(true);
  const sessionConfig = (JSON.parse(readFileSync(args, "utf8")) as string[]).at(-1)!;
  expect(sessionConfig).toMatch(/^\/workspace\/\.webaios\/sessions\/[0-9a-f]{16}\.json$/);
  expect(await rawStatus(port, { Host: host, Authorization: auth(path.join(space, sessionConfig.slice("/workspace/".length))) })).toBe(401);
});

it("the server listens on 127.0.0.1 only", async () => {
  await launch();
  const { port } = await connectClient(m);
  const address = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (!address) return console.warn("no non-internal IPv4 address: the 127.0.0.1-only check cannot run here");
  const error = await new Promise<NodeJS.ErrnoException | null>((ok) => {
    const s = connect(port, address);
    s.once("connect", () => (s.destroy(), ok(null)));
    s.once("error", (e) => ok(e));
  });
  expect(error?.code).toBe("ECONNREFUSED");
});

it("a folder under <dataDir> is refused with SPACE_FOLDER", async () => {
  await launch();
  const { port, token: token } = await connectClient(m);
  const c = await mcpClient(port, token);
  try {
    const inside = [path.join(w!.dataDir, "design", "x"), path.join(w!.dataDir, "espace", "projets", "x")];
    // Existing folders: a missing one is refused earlier, for another reason.
    for (const d of inside) mkdirSync(d, { recursive: true });
    for (const folder of [w!.dataDir, ...inside]) {
      const r = (await c.callTool({ name: "declare_project", arguments: { folder: folder, ports: [18765] } })) as { isError?: boolean };
      expect(textOf(r), folder).toContain(SPACE_FOLDER);
      expect(r.isError).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 500));
    expect(await count(tid("projet-externe"))).toBe(0);
    for (const d of inside) expect(readdirSync(d)).toEqual([]);
  } finally {
    await c.close();
  }
});

it("the token appears in no file under <dataDir> nor the profile", async () => {
  await launch();
  const p = await declareProject(m, { dataDir: w!.dataDir });
  await p.client.close();
  await new Promise((r) => setTimeout(r, 800));
  const token = Buffer.from(p.token);
  for (const f of [...filesOf(w!.dataDir), ...filesOf(w!.profile)]) {
    let content: Buffer;
    try {
      content = readFileSync(f);
    } catch {
      continue; // a lock or a file gone meanwhile
    }
    expect(content.includes(token), f).toBe(false);
  }
});

// Review Focus 1
it("after a host restart the server comes back on the same port and the same token still connects", { timeout: 120_000 }, async () => {
  const port = await freePort();
  await launch({ WEBAIOS_PORT_MCP_EXTERNAL: String(port) });
  const { port: shown, token: token } = await connectClient(m);
  expect(shown).toBe(port);
  await click(m, tid("fermer-commande"));
  const before = await mcpClient(port, token);
  expect((await before.listTools()).tools.length).toBeGreaterThan(0);
  await before.close();
  process.kill((await hostPid())!, "SIGKILL");
  await waitFor<number | null>(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`, (pid) => pid === null);
  // While no host runs: the reason, and « Brancher » greyed.
  await waitText(tid("raison-externes"), failureReason(new Error(HOST_STOPPED)));
  expect(await connectDisabled()).toBe(true);
  await storeEval("await store.agent.ensure();");
  await waitCount(tid("raison-externes"), 0, 30_000);
  expect(await connectDisabled()).toBe(false);
  const after = await mcpClient(port, token);
  try {
    expect((await after.listTools()).tools.length).toBeGreaterThan(0);
  } finally {
    await after.close();
  }
});
