import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spacePaths, type SpacePaths } from "../../src/paths.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { giveGrant, removeGrant } from "../../src/widgets/grants.js";
import { approveReads } from "../../src/widgets/reads.js";
import { ACTION_STOPPED, readRun, listRuns } from "../../src/workflows/executions.js";
import { withMemory, readMemory } from "../../src/workflows/memory.js";
import type { ProcessLauncher } from "../../src/workflows/run.js";
import type { AiAccessRun } from "../../src/ai/dispatcher.js";
import { lastResult, readResult } from "../../src/actions/data.js";
import { ACTION_UNKNOWN as unknownIn, actionGrantRequired, runAction, requiredInput, type OptionsAction, type TraceAction } from "../../src/actions/run.js";
import { DeclarationAction } from "../../src/actions/schemas.js";
import { tempFolder } from "../helpers/temp.js";

const ACTION_UNKNOWN = unknownIn("fr");
const ENGINE = join(import.meta.dirname, "..", "..", "docker", "engine");
const SCRIPT = join(ENGINE, "harvester.mjs");
let instant = Date.parse("2026-10-31T10:00:00.000Z");
// Each call advances by a second: two runs in a row do not have the same id.
const clock = () => new Date((instant += 1000));

const PLAN = {
  blocks: [
    { component: "title", props: { text: "Tickets" } },
    { component: "list", props: { items: "tickets", title: "title" } },
  ],
};

/** A fake Gemma (a run's access): `reponse` returns the plan; its calls are counted. */
function fakeGemma(response: (o?: { signal?: AbortSignal; onStartup?: () => void }) => Promise<unknown> = async () => PLAN) {
  const calls: string[] = [];
  const ai: AiAccessRun & { calls: string[] } = {
    calls: calls,
    kev: async () => ({}),
    gemma: async (g, o) => {
      calls.push(g.prompt);
      o?.onStartup?.();
      return response(o) as never;
    },
    forget: () => {},
  };
  return ai;
}

const toClean: string[] = [];
afterEach(async () => {
  await Promise.all(toClean.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Bench {
  c: SpacePaths;
  actionsFolder: string;
  folder: string;
  commands: string[][];
  deleted: unknown[];
  bridge: FakeBridge;
  launch: ProcessLauncher;
}

const workflow = () =>
  JSON.stringify({
    version: 1,
    blocks: [{ id: "lire", type: "code", params: { source: "lire.mjs" } }, { id: "sortie", type: "output", params: { to: "page" } }],
    links: [{ from: "lire", to: "sortie" }],
  });

/** Without `unapproved`, an action without account has its declared reads approved (like one seeded at the update). */
async function prepare(id: string, declaration: unknown, code: string, o: { suspended?: string[]; unapproved?: true } = {}): Promise<Bench> {
  const root = await tempFolder();
  const c = spacePaths(root);
  const folder = join(c.actions, id);
  await mkdir(folder, { recursive: true });
  await mkdir(c.components, { recursive: true });
  await writeFile(join(folder, "action.json"), JSON.stringify(declaration));
  await writeFile(join(folder, "workflow.json"), workflow());
  await writeFile(join(folder, "lire.mjs"), code);
  const actionsFolder = await tempFolder();
  toClean.push(root, actionsFolder);
  const d = DeclarationAction.safeParse(declaration);
  if (!o.unapproved && d.success && d.data.sources.account.length === 0) await approveReads(actionsFolder, id, { public: d.data.sources.public, web: d.data.sources.web });
  const bridge = new FakeBridge([], {
    active: null,
    allow: false,
    read: { pages: [{ url: "https://gitlab.com/tickets", title: "Ouvrir la porte", text: "", links: [] }], ...(o.suspended ? { suspended: o.suspended } : {}) },
  });
  const b: Bench = {
    c,
    actionsFolder: actionsFolder,
    folder: folder,
    commands: [],
    deleted: [],
    bridge: bridge,
    launch: (cmd, args) => {
      b.commands.push([cmd, ...args]);
      const e = spawn(process.execPath, [SCRIPT, folder], { stdio: ["pipe", "pipe", "pipe"] });
      return { stdin: e.stdin, stdout: e.stdout, stderr: e.stderr, kill: () => void e.kill("SIGKILL"), end: new Promise((ok) => e.on("close", (x) => ok(x))) };
    },
  };
  return b;
}

const options = (b: Bench, id: string, o: Partial<OptionsAction> = {}): OptionsAction => ({
  id,
  paths: b.c,
  actionsFolder: b.actionsFolder,
  engine: ENGINE,
  workshop: {
    stageHarvest: async (_p, d) => d,
    harvestCommand: (p, d, m) => ["docker", "run", JSON.stringify(p), d, m],
    deleteHarvest: async (p) => void b.deleted.push(p),
  },
  launch: b.launch,
  bridge: b.bridge,
  ai: fakeGemma(),
  clock: clock,
  locale: () => "fr",
  input: null,
  trigger: "manual",
  signal: new AbortController().signal,
  onTrace: () => {},
  onStep: () => {},
  localAddresses: true,
  ...o,
});

const GITLAB = { name: "GitLab", sources: { account: ["gitlab.com"] }, layout: "Les tickets en liste" };
const CODE_GITLAB = `export default async (e, w) => { const p = await w.readPage("https://gitlab.com/tickets", { account: true }); return { tickets: [{ title: p.title }] }; };`;
const gitlabGrant = (b: Bench) => giveGrant(b.actionsFolder, "gitlab", { domains: ["gitlab.com"], public: [], profile: "perso" });

describe("runAction", () => {
  it("GitLab action with a grant: run reussie, result and plan written, status reussie", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB);
    await gitlabGrant(b);
    const ai = fakeGemma();
    const steps: string[] = [];
    const r = await runAction(options(b, "gitlab", { ai: ai, onStep: (e) => steps.push(e) }));
    expect(r).toMatchObject({ status: "succeeded" });
    expect(r.run).toBeDefined();
    const e = await readRun(join(b.actionsFolder, "gitlab"), r.run!);
    expect(e).toMatchObject({ status: "succeeded", owner: { type: "action", id: "gitlab" }, trigger: "manual" });
    const res = await readResult(b.actionsFolder, "gitlab", r.run!);
    expect(res).toEqual({
      version: 1,
      run: r.run,
      input: null,
      results: { tickets: [{ title: "Ouvrir la porte" }] },
      plan: PLAN,
      fallback: false,
      empty: false,
    });
    expect(ai.calls).toHaveLength(1);
    // The action's instruction is given to Gemma.
    expect(ai.calls[0]).toContain("Les tickets en liste");
    expect(steps).toEqual(["layout"]);
  });

  it("without a grant: accord-requis, no container launched, nothing written", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB);
    const r = await runAction(options(b, "gitlab"));
    expect(r).toEqual({ status: "grant-required", error: actionGrantRequired(DeclarationAction.parse(GITLAB), "fr"), kernelError: true });
    expect(r.error).toBe("Accord requis pour lire avec ton compte : gitlab.com");
    expect(b.commands).toEqual([]);
    expect(existsSync(join(b.actionsFolder, "gitlab"))).toBe(false);
  });

  it("without account, an unapproved public domain stops before the container; approved, it runs; a lost domain still runs", async () => {
    const declaration = { name: "P", sources: { public: ["gitlab.com"] } };
    const code = `export default async (e, w) => ({ tickets: [{ title: (await w.readPage("https://gitlab.com/tickets")).titre }] });`;
    const b = await prepare("public", declaration, code, { unapproved: true });
    const r = await runAction(options(b, "public"));
    expect(r).toEqual({ status: "grant-required", error: "Accord requis pour lire : gitlab.com", kernelError: true });
    expect(b.commands).toEqual([]);
    await approveReads(b.actionsFolder, "public", { public: ["gitlab.com", "x.fr"], web: false });
    expect((await runAction(options(b, "public"))).status).toBe("succeeded");
    await writeFile(join(b.folder, "action.json"), JSON.stringify({ name: "P", sources: { public: ["gitlab.com"], web: true } }));
    expect((await runAction(options(b, "public"))).error).toBe("Accord requis pour lire : gitlab.com et le web");
  });

  it("a stale grant (domains changed) is removed, the data erased", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB);
    await gitlabGrant(b);
    const first = await runAction(options(b, "gitlab"));
    expect(first.status).toBe("succeeded");
    await writeFile(join(b.folder, "action.json"), JSON.stringify({ ...GITLAB, sources: { account: ["gitlab.com", "github.com"] } }));
    const r = await runAction(options(b, "gitlab"));
    expect(r.status).toBe("grant-required");
    expect(await listRuns(join(b.actionsFolder, "gitlab"))).toEqual([]);
  });

  it("unknown action: ACTION_UNKNOWN, nothing written", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB);
    const r = await runAction(options(b, "absente"));
    expect(r).toMatchObject({ status: "invalid", error: ACTION_UNKNOWN });
    expect(existsSync(join(b.actionsFolder, "absente"))).toBe(false);
  });

  it("invalid workflow: invalide status, nothing written, no container", async () => {
    const b = await prepare("cassee", { name: "C", sources: {} }, `export default async () => 1;`);
    await writeFile(join(b.folder, "workflow.json"), "{pas du json");
    const r = await runAction(options(b, "cassee"));
    expect(r.status).toBe("invalid");
    expect(r.error).toBeTruthy();
    expect(b.commands).toEqual([]);
    expect(existsSync(join(b.actionsFolder, "cassee"))).toBe(false);
  });

  it("saisie requise absente : requiredInput(\"Recherche\")", async () => {
    const b = await prepare("leboncoin", { name: "Leboncoin", sources: {}, input: { label: "Recherche" } }, `export default async (e, w) => ({ q: w.input });`);
    for (const input of [null, "   "]) {
      const r = await runAction(options(b, "leboncoin", { input: input }));
      expect(r).toEqual({ status: "invalid", error: requiredInput("fr", "Recherche"), kernelError: true });
    }
    expect(requiredInput("fr", "Recherche")).toBe("Saisie requise : Recherche");
    expect(b.commands).toEqual([]);
  });

  it("« clio lyon » arrives in debut.saisie and in Execution.saisie", async () => {
    const b = await prepare("leboncoin", { name: "Leboncoin", sources: {}, input: { label: "Recherche" } }, `export default async (e, w) => ({ announcements: [{ title: w.input }] });`);
    const r = await runAction(options(b, "leboncoin", { input: "  clio lyon  " }));
    expect(r.status).toBe("succeeded");
    const e = await readRun(join(b.actionsFolder, "leboncoin"), r.run!);
    expect(e?.input).toBe("clio lyon");
    const res = await readResult(b.actionsFolder, "leboncoin", r.run!);
    // The agent's code received the input (sent in debut).
    expect(res?.results).toEqual({ announcements: [{ title: "clio lyon" }] });
    expect(res?.input).toBe("clio lyon");
    // The summary carries it too (menu of the previous results on the action's page).
    expect((await listRuns(join(b.actionsFolder, "leboncoin")))[0]?.input).toBe("clio lyon");
  });

  it("an input that is too long is cut to 200 characters", async () => {
    const b = await prepare("leboncoin", { name: "Leboncoin", sources: {}, input: { label: "Recherche" } }, `export default async (e, w) => ({ announcements: [{ title: w.input }] });`);
    const r = await runAction(options(b, "leboncoin", { input: "x".repeat(500) }));
    expect(r.status).toBe("succeeded");
    expect((await readRun(join(b.actionsFolder, "leboncoin"), r.run!))?.input).toBe("x".repeat(200));
  });

  it("empty results: empty result, Gemma never called", async () => {
    const b = await prepare("vide", { name: "V", sources: {} }, `export default async () => ({ tickets: [] });`);
    const ai = fakeGemma();
    const r = await runAction(options(b, "vide", { ai: ai }));
    expect(r.status).toBe("succeeded");
    const res = await readResult(b.actionsFolder, "vide", r.run!);
    expect(res).toMatchObject({ empty: true, plan: null, fallback: false });
    expect(ai.calls).toEqual([]);
  });

  it("Gemma absente : plan de secours, secours true", async () => {
    const b = await prepare("simple", { name: "S", sources: {} }, `export default async () => ({ tickets: [{ title: "a" }] });`);
    const r = await runAction(options(b, "simple", { ai: null }));
    expect(r.status).toBe("succeeded");
    const res = await readResult(b.actionsFolder, "simple", r.run!);
    expect(res?.fallback).toBe(true);
    expect(res?.plan?.blocks.length).toBeGreaterThan(0);
  });

  it("the blocks' memory is written after the result; a failure does not touch it", async () => {
    const b = await prepare("memo", { name: "M", sources: {} }, `export default async () => 1;`);
    const lines = (end: unknown) => [
      { t: "block", id: "lire", step: "start" },
      { t: "block", id: "lire", step: "end", status: "succeeded", output: { tickets: [{ title: "a" }] } },
      { t: "memory", memory: { lire: { type: "code", value: { seen: 1 } } } },
      { t: "block", id: "sortie", step: "start" },
      { t: "block", id: "sortie", step: "end", status: "succeeded", output: { tickets: [{ title: "a" }] } },
      end,
    ];
    const r = await runAction(options(b, "memo", { launch: launcherLines(lines({ t: "end", data: { tickets: [{ title: "a" }] } })) }));
    expect(r.status).toBe("succeeded");
    expect((await readMemory(join(b.actionsFolder, "memo"))).lire).toMatchObject({ type: "code", value: { seen: 1 } });
    const failure = await runAction(options(b, "memo", { launch: launcherLines([{ t: "memory", memory: { lire: { type: "code", value: { seen: 2 } } } }, { t: "failure", error: "cassé" }]) }));
    expect(failure.status).toBe("failed");
    expect((await readMemory(join(b.actionsFolder, "memo"))).lire).toMatchObject({ value: { seen: 1 } });
  });

  it("action deleted just before the memory write: the memory is not written", async () => {
    const b = await prepare("memo", { name: "M", sources: {} }, `export default async () => 1;`);
    const lines = [
      { t: "block", id: "lire", step: "start" },
      { t: "block", id: "lire", step: "end", status: "succeeded", output: { tickets: [{ title: "a" }] } },
      { t: "memory", memory: { lire: { type: "code", value: { seen: 1 } } } },
      { t: "block", id: "sortie", step: "start" },
      { t: "block", id: "sortie", step: "end", status: "succeeded", output: { tickets: [{ title: "a" }] } },
      { t: "end", data: { tickets: [{ title: "a" }] } },
    ];
    const dataFolder = join(b.actionsFolder, "memo");
    // The memory is held (as during the erasing of its data): the run waits its turn to write it.
    let release!: () => void;
    const held = withMemory(dataFolder, () => new Promise<void>((ok) => (release = ok)));
    const end = runAction(options(b, "memo", { launch: launcherLines(lines) }));
    await waitUntil(() => existsSync(join(dataFolder, "results")));
    // The time the re-read that follows the result takes: the action is still there.
    await new Promise((ok) => setTimeout(ok, 200));
    await rm(b.folder, { recursive: true, force: true });
    release();
    await held;
    const r = await end;
    expect(r.error).toBe(ACTION_UNKNOWN);
    expect(await readMemory(dataFolder)).toEqual({});
    expect(await listRuns(dataFolder)).toEqual([]);
  });

  it("grant removed during the run: nothing remains", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB, { suspended: ["https://gitlab.com/tickets"] });
    await gitlabGrant(b);
    const end = runAction(options(b, "gitlab"));
    await waitUntil(() => b.bridge.calls.some((a) => a.method === "readPageInvisible"));
    await removeGrant(b.actionsFolder, "gitlab");
    b.bridge.release("https://gitlab.com/tickets");
    const r = await end;
    expect(r.status).toBe("grant-required");
    expect(r.run).toBeUndefined();
    expect(await listRuns(join(b.actionsFolder, "gitlab"))).toEqual([]);
    expect(await lastResult(b.actionsFolder, "gitlab")).toBeNull();
  });

  it("folder deleted during: nothing is written", async () => {
    const b = await prepare("public", { name: "P", sources: { public: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ title: (await w.readPage("https://gitlab.com/tickets")).titre }] });`, {
      suspended: ["https://gitlab.com/tickets"],
    });
    const end = runAction(options(b, "public"));
    await waitUntil(() => b.bridge.calls.some((a) => a.method === "readPageInvisible"));
    await rm(b.folder, { recursive: true, force: true });
    b.bridge.release("https://gitlab.com/tickets");
    const r = await end;
    expect(r.run).toBeUndefined();
    expect(r.status).toBe("invalid");
    expect(r.error).toBe(ACTION_UNKNOWN);
    expect(await listRuns(join(b.actionsFolder, "public"))).toEqual([]);
  });

  it("actions folder missing for a moment during the run: nothing is written, the history stays", async () => {
    const b = await prepare("public", { name: "P", sources: { public: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ title: (await w.readPage("https://gitlab.com/tickets")).titre }] });`);
    const first = await runAction(options(b, "public"));
    expect(first.status).toBe("succeeded");
    const beforeMemory = await readMemory(join(b.actionsFolder, "public"));
    // During the second one's layout, the actions folder disappears (volume unmounted, renamed…).
    const elsewhere = `${b.c.actions}-ailleurs`;
    const ai = fakeGemma(async () => {
      await rename(b.c.actions, elsewhere);
      return PLAN;
    });
    const r = await runAction(options(b, "public", { ai: ai }));
    await rename(elsewhere, b.c.actions);
    expect(r).toMatchObject({ status: "invalid", error: ACTION_UNKNOWN });
    expect((await listRuns(join(b.actionsFolder, "public"))).map((e) => e.id)).toEqual([first.run]);
    expect((await lastResult(b.actionsFolder, "public"))?.run).toBe(first.run);
    expect(await readMemory(join(b.actionsFolder, "public"))).toEqual(beforeMemory);
  });

  it("kernel stop during the layout: run interrupted, without a result", async () => {
    const b = await prepare("simple", { name: "S", sources: {} }, `export default async () => ({ tickets: [{ title: "a" }] });`);
    const stop = new AbortController();
    let quit = false;
    const ai = fakeGemma(
      (o) =>
        new Promise((_ok, ko) => {
          o?.signal?.addEventListener("abort", () => ko(new Error("abandon")));
          setImmediate(() => {
            quit = true;
            stop.abort();
          });
        }),
    );
    const r = await runAction(options(b, "simple", { ai: ai, signal: stop.signal, interrupted: () => quit }));
    expect(r).toMatchObject({ status: "interrupted", error: "Interrompue : Ressac s'est arrêté", kernelError: true });
    expect(await readRun(join(b.actionsFolder, "simple"), r.run!)).toMatchObject({ status: "interrupted" });
    expect(await readResult(b.actionsFolder, "simple", r.run!)).toBeNull();
  });

  it("signal raised during the workflow: interrompue, ACTION_STOPPED; during the layout: reussie with fallback plan", async () => {
    const b = await prepare("public", { name: "P", sources: { public: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ title: (await w.readPage("https://gitlab.com/tickets")).titre }] });`, {
      suspended: ["https://gitlab.com/tickets"],
    });
    const stop = new AbortController();
    const end = runAction(options(b, "public", { signal: stop.signal }));
    await waitUntil(() => b.bridge.calls.some((a) => a.method === "readPageInvisible"));
    stop.abort();
    const r = await end;
    expect(r).toMatchObject({ status: "interrupted", error: ACTION_STOPPED("fr"), kernelError: true });
    const e = await readRun(join(b.actionsFolder, "public"), r.run!);
    expect(e).toMatchObject({ status: "interrupted", error: ACTION_STOPPED("fr") });
    expect(await readResult(b.actionsFolder, "public", r.run!)).toBeNull();

    // During the layout: Gemma waits, the stop gives the fallback layout.
    const b2 = await prepare("simple", { name: "S", sources: {} }, `export default async () => ({ tickets: [{ title: "a" }] });`);
    const arret2 = new AbortController();
    const ai = fakeGemma(
      (o) =>
        new Promise((_ok, ko) => {
          o?.signal?.addEventListener("abort", () => ko(new Error("abandon")));
          setImmediate(() => arret2.abort());
        }),
    );
    const r2 = await runAction(options(b2, "simple", { ai: ai, signal: arret2.signal }));
    expect(r2.status).toBe("succeeded");
    expect((await readResult(b2.actionsFolder, "simple", r2.run!))?.fallback).toBe(true);
  });

  it("kernel stop (interrompue): written run interrupted", async () => {
    const b = await prepare("public", { name: "P", sources: { public: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ title: (await w.readPage("https://gitlab.com/tickets")).titre }] });`, {
      suspended: ["https://gitlab.com/tickets"],
    });
    const stop = new AbortController();
    const end = runAction(options(b, "public", { signal: stop.signal, interrupted: () => true }));
    await waitUntil(() => b.bridge.calls.some((a) => a.method === "readPageInvisible"));
    stop.abort();
    const r = await end;
    expect(r.status).toBe("interrupted");
    const e = await readRun(join(b.actionsFolder, "public"), r.run!);
    expect(e).toMatchObject({ status: "interrupted", error: "Interrompue : Ressac s'est arrêté", kernelError: true });
  });

  it("the workflow's traces are relayed", async () => {
    const b = await prepare("simple", { name: "S", sources: {} }, `export default async () => ({ tickets: [{ title: "a" }] });`);
    const traces: TraceAction[] = [];
    await runAction(options(b, "simple", { onTrace: (t) => traces.push(t) }));
    expect(traces).toContainEqual({ block: "lire", step: "start", type: "code" });
    // Each trace carries the block's type: the action's page shows its catalog label.
    expect(traces.every((t) => t.type === (t.block === "lire" ? "code" : "output"))).toBe(true);
  });

  it("trial: -attempt run, result written, neither memory nor last result changed", async () => {
    const b = await prepare("simple", { name: "S", sources: {} }, `export default async () => ({ tickets: [{ title: "a" }] });`);
    const real = await runAction(options(b, "simple"));
    expect(real.status).toBe("succeeded");
    const memoryBefore = await readMemory(join(b.actionsFolder, "simple"));
    const ai = fakeGemma();
    const r = await runAction(options(b, "simple", { ai: ai, trigger: "replay", attempt: { origin: real.run!, start: "lire" } }));
    expect(r.status).toBe("succeeded");
    expect(r.run).toMatch(/-attempt$/);
    const e = await readRun(join(b.actionsFolder, "simple"), r.run!);
    expect(e).toMatchObject({ trigger: "replay", attempt: { start: "lire", origin: real.run } });
    expect((await readResult(b.actionsFolder, "simple", r.run!))?.plan).toEqual(PLAN);
    expect((await lastResult(b.actionsFolder, "simple"))?.run).toBe(real.run);
    expect(await readMemory(join(b.actionsFolder, "simple"))).toEqual(memoryBefore);
  });

  it("trial from a missing run: refused, nothing written", async () => {
    const b = await prepare("simple", { name: "S", sources: {} }, `export default async () => ({ tickets: [{ title: "a" }] });`);
    const r = await runAction(options(b, "simple", { trigger: "replay", attempt: { origin: "2020-01-01T00-00-00-000Z", start: "lire" } }));
    expect(r.status).toBe("invalid");
    expect(b.commands).toEqual([]);
  });
});

/** A fake container that writes these lines then exits with 0. */
function launcherLines(lines: unknown[]): ProcessLauncher {
  return () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const end = new Promise<number | null>((ok) => {
      setImmediate(() => {
        for (const l of lines) stdout.write(JSON.stringify(l) + "\n");
        stdout.end();
        stderr.end();
        setImmediate(() => ok(0));
      });
    });
    return { stdin, stdout, stderr, kill: () => {}, end: end };
  };
}

async function waitUntil(f: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("attente dépassée");
    await new Promise((ok) => setTimeout(ok, 10));
  }
}
