import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spacePaths, type SpacePaths } from "../../src/paths.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { giveGrant, removeGrant } from "../../src/widgets/grants.js";
import { ACTION_STOPPED, readRun, listRuns } from "../../src/workflows/executions.js";
import { withMemory, readMemory } from "../../src/workflows/memory.js";
import type { ProcessLauncher, DirectTrace } from "../../src/workflows/run.js";
import type { AiAccessRun } from "../../src/ai/dispatcher.js";
import { lastResult, readResult } from "../../src/actions/data.js";
import { ACTION_UNKNOWN, actionGrantRequired, runAction, requiredInput, type OptionsAction, type TraceAction } from "../../src/actions/run.js";
import { DeclarationAction } from "../../src/actions/schemas.js";
import { tempFolder } from "../helpers/temp.js";

const ENGINE = join(import.meta.dirname, "..", "..", "docker", "moteur");
const SCRIPT = join(ENGINE, "recolteur.mjs");
let instant = Date.parse("2026-10-31T10:00:00.000Z");
// Each call advances by a second: two runs in a row do not have the same id.
const clock = () => new Date((instant += 1000));

const PLAN = {
  blocks: [
    { component: "titre", props: { text: "Tickets" } },
    { component: "liste", props: { items: "tickets", title: "titre" } },
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
    blocks: [{ id: "lire", type: "code", params: { source: "lire.mjs" } }, { id: "sortie", type: "sortie", params: { to: "page" } }],
    links: [{ from: "lire", to: "sortie" }],
  });

async function prepare(id: string, declaration: unknown, code: string, o: { suspended?: string[] } = {}): Promise<Bench> {
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
    harvestCommand: (p, d, m) => ["docker", "run", JSON.stringify(p), d, m],
    deleteHarvest: async (p) => void b.deleted.push(p),
  },
  launch: b.launch,
  bridge: b.bridge,
  ai: fakeGemma(),
  clock: clock,
  input: null,
  trigger: "manuelle",
  signal: new AbortController().signal,
  onTrace: () => {},
  onStep: () => {},
  localAddresses: true,
  ...o,
});

const GITLAB = { name: "GitLab", sources: { account: ["gitlab.com"] }, layout: "Les tickets en liste" };
const CODE_GITLAB = `export default async (e, w) => { const p = await w.lirePage("https://gitlab.com/tickets", { compte: true }); return { tickets: [{ titre: p.titre }] }; };`;
const gitlabGrant = (b: Bench) => giveGrant(b.actionsFolder, "gitlab", { domains: ["gitlab.com"], public: [], profile: "perso" });

describe("runAction", () => {
  it("GitLab action with a grant: run reussie, result and plan written, status reussie", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB);
    await gitlabGrant(b);
    const ai = fakeGemma();
    const steps: string[] = [];
    const r = await runAction(options(b, "gitlab", { ai: ai, onStep: (e) => steps.push(e) }));
    expect(r).toMatchObject({ status: "reussie" });
    expect(r.run).toBeDefined();
    const e = await readRun(join(b.actionsFolder, "gitlab"), r.run!);
    expect(e).toMatchObject({ status: "reussie", owner: { type: "action", id: "gitlab" }, trigger: "manuelle" });
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
    expect(steps).toEqual(["mise-en-page"]);
  });

  it("without a grant: accord-requis, no container launched, nothing written", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB);
    const r = await runAction(options(b, "gitlab"));
    expect(r).toEqual({ status: "accord-requis", error: actionGrantRequired(DeclarationAction.parse(GITLAB)), kernelError: true });
    expect(r.error).toBe("Accord requis pour lire avec ton compte : gitlab.com");
    expect(b.commands).toEqual([]);
    expect(existsSync(join(b.actionsFolder, "gitlab"))).toBe(false);
  });

  it("a stale grant (domains changed) is removed, the data erased", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB);
    await gitlabGrant(b);
    const first = await runAction(options(b, "gitlab"));
    expect(first.status).toBe("reussie");
    await writeFile(join(b.folder, "action.json"), JSON.stringify({ ...GITLAB, sources: { account: ["gitlab.com", "github.com"] } }));
    const r = await runAction(options(b, "gitlab"));
    expect(r.status).toBe("accord-requis");
    expect(await listRuns(join(b.actionsFolder, "gitlab"))).toEqual([]);
  });

  it("unknown action: ACTION_UNKNOWN, nothing written", async () => {
    const b = await prepare("gitlab", GITLAB, CODE_GITLAB);
    const r = await runAction(options(b, "absente"));
    expect(r).toMatchObject({ status: "invalide", error: ACTION_UNKNOWN });
    expect(existsSync(join(b.actionsFolder, "absente"))).toBe(false);
  });

  it("invalid workflow: invalide status, nothing written, no container", async () => {
    const b = await prepare("cassee", { name: "C", sources: {} }, `export default async () => 1;`);
    await writeFile(join(b.folder, "workflow.json"), "{pas du json");
    const r = await runAction(options(b, "cassee"));
    expect(r.status).toBe("invalide");
    expect(r.error).toBeTruthy();
    expect(b.commands).toEqual([]);
    expect(existsSync(join(b.actionsFolder, "cassee"))).toBe(false);
  });

  it("saisie requise absente : requiredInput(\"Recherche\")", async () => {
    const b = await prepare("leboncoin", { name: "Leboncoin", sources: {}, input: { label: "Recherche" } }, `export default async (e, w) => ({ q: w.saisie });`);
    for (const input of [null, "   "]) {
      const r = await runAction(options(b, "leboncoin", { input: input }));
      expect(r).toEqual({ status: "invalide", error: requiredInput("Recherche"), kernelError: true });
    }
    expect(requiredInput("Recherche")).toBe("Saisie requise : Recherche");
    expect(b.commands).toEqual([]);
  });

  it("« clio lyon » arrives in debut.saisie and in Execution.saisie", async () => {
    const b = await prepare("leboncoin", { name: "Leboncoin", sources: {}, input: { label: "Recherche" } }, `export default async (e, w) => ({ annonces: [{ titre: w.saisie }] });`);
    const r = await runAction(options(b, "leboncoin", { input: "  clio lyon  " }));
    expect(r.status).toBe("reussie");
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
    const b = await prepare("leboncoin", { name: "Leboncoin", sources: {}, input: { label: "Recherche" } }, `export default async (e, w) => ({ annonces: [{ titre: w.saisie }] });`);
    const r = await runAction(options(b, "leboncoin", { input: "x".repeat(500) }));
    expect(r.status).toBe("reussie");
    expect((await readRun(join(b.actionsFolder, "leboncoin"), r.run!))?.input).toBe("x".repeat(200));
  });

  it("empty results: empty result, Gemma never called", async () => {
    const b = await prepare("vide", { name: "V", sources: {} }, `export default async () => ({ tickets: [] });`);
    const ai = fakeGemma();
    const r = await runAction(options(b, "vide", { ai: ai }));
    expect(r.status).toBe("reussie");
    const res = await readResult(b.actionsFolder, "vide", r.run!);
    expect(res).toMatchObject({ empty: true, plan: null, fallback: false });
    expect(ai.calls).toEqual([]);
  });

  it("Gemma absente : plan de secours, secours true", async () => {
    const b = await prepare("simple", { name: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const r = await runAction(options(b, "simple", { ai: null }));
    expect(r.status).toBe("reussie");
    const res = await readResult(b.actionsFolder, "simple", r.run!);
    expect(res?.fallback).toBe(true);
    expect(res?.plan?.blocks.length).toBeGreaterThan(0);
  });

  it("the blocks' memory is written after the result; a failure does not touch it", async () => {
    const b = await prepare("memo", { name: "M", sources: {} }, `export default async () => 1;`);
    const lignes = (end: unknown) => [
      { t: "bloc", id: "lire", step: "debut" },
      { t: "bloc", id: "lire", step: "fin", status: "reussi", output: { tickets: [{ title: "a" }] } },
      { t: "memoire", memory: { read: { type: "code", value: { seen: 1 } } } },
      { t: "bloc", id: "sortie", step: "debut" },
      { t: "bloc", id: "sortie", step: "fin", status: "reussi", output: { tickets: [{ title: "a" }] } },
      end,
    ];
    const r = await runAction(options(b, "memo", { launch: launcherLines(lignes({ t: "fin", data: { tickets: [{ title: "a" }] } })) }));
    expect(r.status).toBe("reussie");
    expect((await readMemory(join(b.actionsFolder, "memo"))).lire).toMatchObject({ type: "code", value: { seen: 1 } });
    const failure = await runAction(options(b, "memo", { launch: launcherLines([{ t: "memoire", memory: { read: { type: "code", value: { seen: 2 } } } }, { t: "echec", error: "cassé" }]) }));
    expect(failure.status).toBe("echouee");
    expect((await readMemory(join(b.actionsFolder, "memo"))).lire).toMatchObject({ value: { seen: 1 } });
  });

  it("action deleted just before the memory write: the memory is not written", async () => {
    const b = await prepare("memo", { name: "M", sources: {} }, `export default async () => 1;`);
    const lignes = [
      { t: "bloc", id: "lire", step: "debut" },
      { t: "bloc", id: "lire", step: "fin", status: "reussi", output: { tickets: [{ title: "a" }] } },
      { t: "memoire", memory: { read: { type: "code", value: { seen: 1 } } } },
      { t: "bloc", id: "sortie", step: "debut" },
      { t: "bloc", id: "sortie", step: "fin", status: "reussi", output: { tickets: [{ title: "a" }] } },
      { t: "fin", data: { tickets: [{ title: "a" }] } },
    ];
    const dataFolder = join(b.actionsFolder, "memo");
    // The memory is held (as during the erasing of its data): the run waits its turn to write it.
    let release!: () => void;
    const held = withMemory(dataFolder, () => new Promise<void>((ok) => (release = ok)));
    const end = runAction(options(b, "memo", { launch: launcherLines(lignes) }));
    await waitUntil(() => existsSync(join(dataFolder, "resultats")));
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
    await waitUntil(() => b.bridge.calls.some((a) => a.method === "lirePageInvisible"));
    await removeGrant(b.actionsFolder, "gitlab");
    b.bridge.release("https://gitlab.com/tickets");
    const r = await end;
    expect(r.status).toBe("accord-requis");
    expect(r.run).toBeUndefined();
    expect(await listRuns(join(b.actionsFolder, "gitlab"))).toEqual([]);
    expect(await lastResult(b.actionsFolder, "gitlab")).toBeNull();
  });

  it("folder deleted during: nothing is written", async () => {
    const b = await prepare("public", { name: "P", sources: { public: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ titre: (await w.lirePage("https://gitlab.com/tickets")).titre }] });`, {
      suspended: ["https://gitlab.com/tickets"],
    });
    const end = runAction(options(b, "public"));
    await waitUntil(() => b.bridge.calls.some((a) => a.method === "lirePageInvisible"));
    await rm(b.folder, { recursive: true, force: true });
    b.bridge.release("https://gitlab.com/tickets");
    const r = await end;
    expect(r.run).toBeUndefined();
    expect(r.status).toBe("invalide");
    expect(r.error).toBe(ACTION_UNKNOWN);
    expect(await listRuns(join(b.actionsFolder, "public"))).toEqual([]);
  });

  it("actions folder missing for a moment during the run: nothing is written, the history stays", async () => {
    const b = await prepare("public", { name: "P", sources: { public: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ titre: (await w.lirePage("https://gitlab.com/tickets")).titre }] });`);
    const first = await runAction(options(b, "public"));
    expect(first.status).toBe("reussie");
    const beforeMemory = await readMemory(join(b.actionsFolder, "public"));
    // During the second one's layout, the actions folder disappears (volume unmounted, renamed…).
    const elsewhere = `${b.c.actions}-ailleurs`;
    const ai = fakeGemma(async () => {
      await rename(b.c.actions, elsewhere);
      return PLAN;
    });
    const r = await runAction(options(b, "public", { ai: ai }));
    await rename(elsewhere, b.c.actions);
    expect(r).toMatchObject({ status: "invalide", error: ACTION_UNKNOWN });
    expect((await listRuns(join(b.actionsFolder, "public"))).map((e) => e.id)).toEqual([first.run]);
    expect((await lastResult(b.actionsFolder, "public"))?.run).toBe(first.run);
    expect(await readMemory(join(b.actionsFolder, "public"))).toEqual(beforeMemory);
  });

  it("kernel stop during the layout: run interrupted, without a result", async () => {
    const b = await prepare("simple", { name: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
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
    expect(r).toMatchObject({ status: "interrompue", error: "Interrompue : WebAiOs s'est arrêté", kernelError: true });
    expect(await readRun(join(b.actionsFolder, "simple"), r.run!)).toMatchObject({ status: "interrompue" });
    expect(await readResult(b.actionsFolder, "simple", r.run!)).toBeNull();
  });

  it("signal raised during the workflow: interrompue, ACTION_STOPPED; during the layout: reussie with fallback plan", async () => {
    const b = await prepare("public", { name: "P", sources: { public: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ titre: (await w.lirePage("https://gitlab.com/tickets")).titre }] });`, {
      suspended: ["https://gitlab.com/tickets"],
    });
    const stop = new AbortController();
    const end = runAction(options(b, "public", { signal: stop.signal }));
    await waitUntil(() => b.bridge.calls.some((a) => a.method === "lirePageInvisible"));
    stop.abort();
    const r = await end;
    expect(r).toMatchObject({ status: "interrompue", error: ACTION_STOPPED, kernelError: true });
    const e = await readRun(join(b.actionsFolder, "public"), r.run!);
    expect(e).toMatchObject({ status: "interrompue", error: ACTION_STOPPED });
    expect(await readResult(b.actionsFolder, "public", r.run!)).toBeNull();

    // During the layout: Gemma waits, the stop gives the fallback layout.
    const b2 = await prepare("simple", { name: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const arret2 = new AbortController();
    const ai = fakeGemma(
      (o) =>
        new Promise((_ok, ko) => {
          o?.signal?.addEventListener("abort", () => ko(new Error("abandon")));
          setImmediate(() => arret2.abort());
        }),
    );
    const r2 = await runAction(options(b2, "simple", { ai: ai, signal: arret2.signal }));
    expect(r2.status).toBe("reussie");
    expect((await readResult(b2.actionsFolder, "simple", r2.run!))?.fallback).toBe(true);
  });

  it("kernel stop (interrompue): written run interrupted", async () => {
    const b = await prepare("public", { name: "P", sources: { public: ["gitlab.com"] } }, `export default async (e, w) => ({ tickets: [{ titre: (await w.lirePage("https://gitlab.com/tickets")).titre }] });`, {
      suspended: ["https://gitlab.com/tickets"],
    });
    const stop = new AbortController();
    const end = runAction(options(b, "public", { signal: stop.signal, interrupted: () => true }));
    await waitUntil(() => b.bridge.calls.some((a) => a.method === "lirePageInvisible"));
    stop.abort();
    const r = await end;
    expect(r.status).toBe("interrompue");
    const e = await readRun(join(b.actionsFolder, "public"), r.run!);
    expect(e).toMatchObject({ status: "interrompue", error: "Interrompue : WebAiOs s'est arrêté", kernelError: true });
  });

  it("the workflow's traces are relayed", async () => {
    const b = await prepare("simple", { name: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const traces: TraceAction[] = [];
    await runAction(options(b, "simple", { onTrace: (t) => traces.push(t) }));
    expect(traces).toContainEqual({ block: "lire", step: "debut", type: "code" });
    // Each trace carries the block's type: the action's page shows its catalog label.
    expect(traces.every((t) => t.type === (t.block === "lire" ? "code" : "sortie"))).toBe(true);
  });

  it("trial: -essai run, result written, neither memory nor last result changed", async () => {
    const b = await prepare("simple", { name: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const real = await runAction(options(b, "simple"));
    expect(real.status).toBe("reussie");
    const memoryBefore = await readMemory(join(b.actionsFolder, "simple"));
    const ai = fakeGemma();
    const r = await runAction(options(b, "simple", { ai: ai, trigger: "rejeu", attempt: { origin: real.run!, start: "lire" } }));
    expect(r.status).toBe("reussie");
    expect(r.run).toMatch(/-essai$/);
    const e = await readRun(join(b.actionsFolder, "simple"), r.run!);
    expect(e).toMatchObject({ trigger: "rejeu", attempt: { start: "lire", origin: real.run } });
    expect((await readResult(b.actionsFolder, "simple", r.run!))?.plan).toEqual(PLAN);
    expect((await lastResult(b.actionsFolder, "simple"))?.run).toBe(real.run);
    expect(await readMemory(join(b.actionsFolder, "simple"))).toEqual(memoryBefore);
  });

  it("trial from a missing run: refused, nothing written", async () => {
    const b = await prepare("simple", { name: "S", sources: {} }, `export default async () => ({ tickets: [{ titre: "a" }] });`);
    const r = await runAction(options(b, "simple", { trigger: "rejeu", attempt: { origin: "2020-01-01T00-00-00-000Z", start: "lire" } }));
    expect(r.status).toBe("invalide");
    expect(b.commands).toEqual([]);
  });
});

/** A fake container that writes these lines then exits with 0. */
function launcherLines(lignes: unknown[]): ProcessLauncher {
  return () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const end = new Promise<number | null>((ok) => {
      setImmediate(() => {
        for (const l of lignes) stdout.write(JSON.stringify(l) + "\n");
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
