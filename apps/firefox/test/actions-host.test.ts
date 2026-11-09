import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  giveGrant,
  spacePaths,
  writeRun,
  writeResult,
  idExecution,
  readAction,
  type KernelActions,
  type SpacePaths,
  type ActionsState,
  type Execution,
  type ActionLaunch,
  type Kernel,
  type LaunchResult,
} from "../../../packages/kernel/src/index";
import { actionImageAllowed, createActionsHost, linkAllowed, NO_KERNEL_MESSAGE, readShownActions, trashAction } from "../host/actions";
import { GrantSchema, SchemaIdAction, ActionInputSchema } from "../shared/api";

const START = "2026-10-31T10:00:00.000Z";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temporary space with these actions (`action.json`), and the folder of their data outside the space. */
function space(declarations: Record<string, object>): { c: SpacePaths; actionsFolder: string } {
  const root = mkdtempSync(join(tmpdir(), "webaios-actions-host-"));
  dirs.push(root);
  const c = spacePaths(join(root, "WebAiOs"));
  for (const [id, d] of Object.entries(declarations)) {
    mkdirSync(join(c.actions, id), { recursive: true });
    writeFileSync(join(c.actions, id, "action.json"), JSON.stringify(d));
  }
  return { c, actionsFolder: join(root, "profil", "actions") };
}

/** A kept run of the action, with its results; gives its id. */
async function run(actionsFolder: string, id: string, results: unknown, start = START): Promise<string> {
  const ex = idExecution(start);
  const e: Execution = { version: 1, id: ex, owner: { type: "action", id }, trigger: "manuelle", start: start, end: start, status: "reussie", blocks: [] };
  await writeRun(join(actionsFolder, id), e);
  await writeResult(actionsFolder, id, { version: 1, run: ex, input: null, results: results, plan: null, fallback: true, empty: false });
  return ex;
}

describe("input schemas", () => {
  it("accept and refuse these ids, inputs and grants", () => {
    const grant = { id: "gitlab", profile: "defaut", account: ["gitlab.com"], public: [] };
    const ok = (sc: { safeParse: (v: unknown) => { success: boolean } }, vs: unknown[]) => vs.map((v) => sc.safeParse(v).success);
    expect(ok(SchemaIdAction, ["gitlab", "a-1", "", "Git_Lab", "../x", "a".repeat(60), "a".repeat(61), 3, null])).toEqual([true, true, false, false, false, true, false, false, false]);
    expect(ok(ActionInputSchema, [null, "", "x".repeat(2000), "x".repeat(2001), 4, undefined])).toEqual([true, true, true, false, false, false]);
    expect(ok(GrantSchema, [grant, { ...grant, extra: 1 }, { ...grant, id: "../x" }, { ...grant, profile: "" }, { ...grant, account: [""] }, { ...grant, public: Array(101).fill("a.b") }, null])).toEqual([true, false, false, false, false, false, false]);
  });
});

describe("actionImageAllowed", () => {
  // actions.test.ts:116
  it("allows an https address present as is in the results of a run of an action without account", async () => {
    const { c, actionsFolder: actionsFolder } = space({ leboncoin: { name: "Leboncoin", sources: { web: true } } });
    const image = "https://img.test/annonce/1.jpg?rule=ad-large";
    const ex = await run(actionsFolder, "leboncoin", { announcements: [{ title: "Clio", snapshot: image }] });
    expect(await actionImageAllowed({ actionsFolder: actionsFolder, readAction: (id) => readAction(c, id) }, "leboncoin", ex, image)).toBe(true);
  });

  // actions.test.ts:202
  it("refuses an action that has an account grant, even if its declaration no longer has an account", async () => {
    const { c, actionsFolder: actionsFolder } = space({ rewritten: { name: "Réécrite", sources: { web: true } } });
    const image = "https://img.test/a.jpg";
    const ex = await run(actionsFolder, "reecrite", { snapshot: image });
    await giveGrant(actionsFolder, "reecrite", { domains: ["gitlab.com"], public: [], profile: "defaut" });
    expect(await actionImageAllowed({ actionsFolder: actionsFolder, readAction: (id) => readAction(c, id) }, "reecrite", ex, image)).toBe(false);
  });
});

describe("pure helpers", () => {
  // actions.test.ts:285
  it("linkAllowed: only an openable http(s) address present as is in the run's results", async () => {
    const { actionsFolder: actionsFolder } = space({});
    const ex = await run(actionsFolder, "gitlab", { tickets: [{ url: "https://gitlab.com/a/-/issues/1", code: "javascript:alert(1)", local: "http://127.0.0.1:5280/" }] });
    expect(await linkAllowed(actionsFolder, "gitlab", ex, "https://gitlab.com/a/-/issues/1")).toBe(true);
    for (const url of ["https://gitlab.com/a/-/issues/2", "javascript:alert(1)", "http://127.0.0.1:5280/", "https://tiers.test/?d=https://gitlab.com/a/-/issues/1"]) {
      expect(await linkAllowed(actionsFolder, "gitlab", ex, url), url).toBe(false);
    }
    expect(await linkAllowed(actionsFolder, "gitlab", idExecution("2026-10-31T12:00:00.000Z"), "https://gitlab.com/a/-/issues/1")).toBe(false);
    expect(await linkAllowed(actionsFolder, "../gitlab", ex, "https://gitlab.com/a/-/issues/1")).toBe(false);
  });

  // actions.test.ts:296
  it("trashAction puts the folder in the trash (nothing is destroyed) and calls oublier", async () => {
    const { c } = space({ gitlab: { name: "GitLab" } });
    const forgotten: string[] = [];
    await trashAction(c, "gitlab", async (id) => void forgotten.push(id));
    expect(existsSync(join(c.actions, "gitlab"))).toBe(false);
    const trash = readdirSync(join(c.actions, ".corbeille"));
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatch(/^gitlab-\d+$/);
    expect(readFileSync(join(c.actions, ".corbeille", trash[0]!, "action.json"), "utf8")).toContain("GitLab");
    expect(forgotten).toEqual(["gitlab"]);
    await expect(trashAction(c, "../x", async () => {})).rejects.toThrow();
  });

  // actions.test.ts:309
  it("readShownActions: declaration, grant, last result (not a trial), broken action flagged", async () => {
    const { c, actionsFolder: actionsFolder } = space({
      gitlab: { name: "GitLab", description: "Mes tickets", keywords: ["tickets"], sources: { account: ["gitlab.com"] } },
      leboncoin: { name: "Leboncoin", input: { label: "Recherche" }, sources: { web: true } },
    });
    mkdirSync(join(c.actions, "cassee"), { recursive: true });
    writeFileSync(join(c.actions, "cassee", "action.json"), "{");
    const ex = await run(actionsFolder, "leboncoin", { a: 1 });
    const list = await readShownActions(c, actionsFolder);
    expect(list.map((a) => a.id)).toEqual(["cassee", "gitlab", "leboncoin"]);
    expect(list[0]).toMatchObject({ id: "cassee", name: "cassee", keywords: [], input: null, account: [], grant: false, last: null });
    expect(list[0]!.error).toBeTruthy();
    expect(list[1]).toEqual({ id: "gitlab", name: "GitLab", description: "Mes tickets", keywords: ["tickets"], input: null, account: ["gitlab.com"], public: [], grant: false, last: null });
    expect(list[2]).toEqual({ id: "leboncoin", name: "Leboncoin", description: "", keywords: [], input: { label: "Recherche" }, account: [], public: [], grant: false, last: { run: ex, start: START, status: "reussie" } });
  });
});

/** A fake kernel of the actions: notes the launches and stops. */
function fakeKernel(direct: ActionsState = { running: [], waiting: [] }, outcome: LaunchResult | Promise<LaunchResult> = { status: "reussie", run: "x" }) {
  const launched: { id: string; input?: string }[] = [];
  const stoppedList: string[] = [];
  /** Stops and grant removals, in order. */
  const calls: string[] = [];
  const actions = {
    launch: (id: string, o: { input?: string }): ActionLaunch => {
      launched.push({ id, ...(o.input !== undefined ? { input: o.input } : {}) });
      return { already: false, end: Promise.resolve(outcome) };
    },
    stop: (id: string) => {
      stoppedList.push(id);
      calls.push(`arreter:${id}`);
    },
    direct: () => direct,
    page: async () => null,
    runs: async () => [],
    grant: async () => {},
    denyGrant: async (id: string) => void calls.push(`refuserAccord:${id}`),
  } as unknown as KernelActions;
  return { launchedOnes: launched, stopped: stoppedList, calls: calls, kernel: { actions } as unknown as Kernel };
}

function host(o: { direct?: ActionsState; issue?: LaunchResult | Promise<LaunchResult>; noKernel?: boolean } = {}) {
  const { c, actionsFolder: actionsFolder } = space({
    gitlab: { name: "GitLab", sources: { account: ["gitlab.com"] } },
    leboncoin: { name: "Leboncoin", input: { label: "Recherche" }, sources: { web: true } },
  });
  const fake = fakeKernel(o.direct, o.issue);
  let changes = 0;
  let clock = 10_000;
  const create = (kernel: Kernel | null = fake.kernel) =>
    createActionsHost({ paths: c, actionsFolder: actionsFolder, kernel: () => (o.noKernel ? null : kernel), onChange: () => void changes++, now: () => clock });
  return { h: create(), create: create, c, actionsFolder: actionsFolder, ...fake, changes: () => changes, forward: (ms: number) => (clock += ms) };
}

describe("preparer", () => {
  // actions.test.ts:413
  it("reads without launching: running, waiting or missing input give lancer false", async () => {
    const { h, launchedOnes: launched } = host();
    expect(await h.prepare("gitlab", null)).toEqual({ ok: true, name: "GitLab", launch: true });
    expect(await h.prepare("leboncoin", "clio lyon")).toEqual({ ok: true, name: "Leboncoin", launch: true });
    expect(await h.prepare("leboncoin", null)).toEqual({ ok: true, name: "Leboncoin", launch: false });
    expect(await h.prepare("leboncoin", "  ")).toEqual({ ok: true, name: "Leboncoin", launch: false });
    const current = { action: "gitlab", start: START, input: null, attempt: false, step: "workflow", blocks: {} } as unknown as ActionsState["running"][number];
    expect(await host({ direct: { running: [current], waiting: [] } }).h.prepare("gitlab", null)).toEqual({ ok: true, name: "GitLab", launch: false });
    expect(await host({ direct: { running: [], waiting: [{ action: "gitlab", since: START }] } }).h.prepare("gitlab", null)).toMatchObject({ launch: false });
    expect(launched).toEqual([]);
  });

  // actions.test.ts:423
  it("an unknown action or a missing kernel is refused", async () => {
    const { h } = host();
    expect(await h.prepare("inconnue", null)).toEqual({ ok: false, error: "Action inconnue" });
    expect(await h.prepare("../x", null)).toEqual({ ok: false, error: "Action inconnue" });
    expect(await host({ noKernel: true }).h.prepare("gitlab", null)).toEqual({ ok: false, error: NO_KERNEL_MESSAGE });
  });
});

describe("lancer, refusals and deletion", () => {
  it("nom is read without the kernel; lancer and arreter go to the kernel", async () => {
    const { h, launchedOnes: launched, stopped: stoppedList, create: create } = host();
    expect(await create(null).name("gitlab")).toBe("GitLab");
    expect(await h.name("absente")).toBeNull();
    expect(await h.launch("leboncoin", "clio")).toEqual({ status: "reussie", run: "x" });
    h.stop("leboncoin");
    expect(launched).toEqual([{ id: "leboncoin", input: "clio" }]);
    expect(stoppedList).toEqual(["leboncoin"]);
    expect(await create(null).launch("gitlab", null)).toEqual({ status: "invalide", error: NO_KERNEL_MESSAGE });
  });

  it("executions and execution read the disk without the kernel and refuse bad ids; page is refused", async () => {
    const { create: create, actionsFolder: actionsFolder } = host();
    const ex = await run(actionsFolder, "gitlab", { a: 1 });
    const h = create(null);
    expect((await h.runs("gitlab")).map((e) => e.id)).toEqual([ex]);
    expect(await h.runs("../x")).toEqual([]);
    expect((await h.run("gitlab", ex))?.id).toBe(ex);
    expect(await h.run("gitlab", "../x")).toBeNull();
    expect(await h.run("../x", ex)).toBeNull();
    expect(await h.direct()).toEqual({ running: [], waiting: [] });
    // The page is the kernel's: refused without it, so the chrome reads it again once the kernel runs.
    await expect(h.page("gitlab", null)).rejects.toThrow(NO_KERNEL_MESSAGE);
  });

  // actions.test.ts:462
  it("a launch refused without a run written is shown by the list, until a more recent run", async () => {
    const outcome: LaunchResult = { status: "echouee", error: "Docker n'est pas démarré", kernelError: true };
    const { h, actionsFolder: actionsFolder, changes, forward: advance } = host({ issue: outcome });
    await h.launch("gitlab", null);
    expect(changes()).toBe(1);
    expect((await h.list()).find((a) => a.id === "gitlab")?.denial).toBe("Docker n'est pas démarré");
    expect((await h.list()).find((a) => a.id === "leboncoin")?.denial).toBeUndefined();
    advance(1000);
    await run(actionsFolder, "gitlab", { a: 1 });
    expect((await h.list()).find((a) => a.id === "gitlab")?.denial).toBeUndefined();
  });

  // actions.test.ts:476
  it("a launch refusal survives a restart; launching again clears it from the disk too", async () => {
    const outcome: LaunchResult = { status: "echouee", error: "Docker n'est pas démarré", kernelError: true };
    const { h, create: create } = host({ issue: outcome });
    await h.launch("gitlab", null);
    await expect.poll(async () => (await h.list()).find((a) => a.id === "gitlab")?.denial).toBe("Docker n'est pas démarré");
    const after = create(fakeKernel(undefined, { status: "reussie", run: "x" }).kernel);
    await expect.poll(async () => (await after.list()).find((a) => a.id === "gitlab")?.denial).toBe("Docker n'est pas démarré");
    await after.launch("gitlab", null);
    await expect.poll(async () => (await create().list()).find((a) => a.id === "gitlab")?.denial).toBeUndefined();
  });

  // actions.test.ts:491
  it("deleting also clears the refusal from the disk: an action made again has none at the next start", async () => {
    const outcome: LaunchResult = { status: "echouee", error: "Docker n'est pas démarré", kernelError: true };
    const { h, c, create: create } = host({ issue: outcome });
    await h.launch("gitlab", null);
    await expect.poll(async () => (await h.list()).find((a) => a.id === "gitlab")?.denial).toBe("Docker n'est pas démarré");
    const declaration = readFileSync(join(c.actions, "gitlab", "action.json"));
    expect(await h.supprimer("gitlab")).toEqual({ ok: true });
    mkdirSync(join(c.actions, "gitlab"), { recursive: true });
    writeFileSync(join(c.actions, "gitlab", "action.json"), declaration);
    const denialOf = async () => {
      const a = (await create().list()).find((x) => x.id === "gitlab");
      return a ? (a.denial ?? "aucun") : "absente";
    };
    await expect.poll(denialOf).toBe("aucun");
  });

  // actions.test.ts:508
  it("lancer notes a refusal without a run; an outcome with a run leaves none", async () => {
    const { h, changes } = host({ issue: { status: "invalide", error: "Cette action n'a pas de workflow.json", kernelError: true } });
    await h.launch("gitlab", null);
    expect((await h.list()).find((a) => a.id === "gitlab")?.denial).toBe("Cette action n'a pas de workflow.json");
    expect((await h.launch("gitlab", null)).error).toBe("Cette action n'a pas de workflow.json");
    expect(changes()).toBe(2);
    const ok = host();
    await ok.h.launch("gitlab", null);
    expect((await ok.h.list()).find((a) => a.id === "gitlab")?.denial).toBeUndefined();
    expect(ok.changes()).toBe(0);
  });

  // actions.test.ts:523
  it("deleting and removing the grant stop the running action first", async () => {
    const { h, calls: calls } = host();
    await h.denyGrant("gitlab");
    expect(calls).toEqual(["arreter:gitlab", "refuserAccord:gitlab"]);
    calls.length = 0;
    expect(await h.supprimer("gitlab")).toEqual({ ok: true });
    expect(calls).toEqual(["arreter:gitlab", "refuserAccord:gitlab"]);
    expect(await h.supprimer("gitlab")).toEqual({ ok: false, error: "Action inconnue" });
  });

  // actions.test.ts:532
  it("deleting during a launch: the stopped run that ends writing nothing leaves no refusal for an action made again", async () => {
    let finish!: (r: LaunchResult) => void;
    const outcome = new Promise<LaunchResult>((ok) => (finish = ok));
    const { h, changes } = host({ issue: outcome });
    void h.launch("gitlab", null);
    expect(await h.supprimer("gitlab")).toEqual({ ok: true });
    finish({ status: "echouee", error: "Action inconnue", kernelError: true });
    await new Promise((ok) => setTimeout(ok, 0));
    expect(changes()).toBe(0);
    expect((await h.list()).find((a) => a.id === "gitlab")?.denial).toBeUndefined();
  });

  it("accorder answers the kernel's refusal as an error", async () => {
    const { h, create: create } = host();
    expect(await h.grant({ id: "gitlab", profile: "defaut", account: ["gitlab.com"], public: [] })).toEqual({ ok: true });
    expect(await create(null).grant({ id: "gitlab", profile: "defaut", account: [], public: [] })).toEqual({ ok: false, error: NO_KERNEL_MESSAGE });
  });
});

describe("directVu", () => {
  it("calls surChange once when a run leaves courantes", () => {
    const { h, changes } = host();
    const current = { action: "gitlab", start: START, input: null, attempt: false, step: "workflow", blocks: {} } as unknown as ActionsState["running"][number];
    h.directSeen({ running: [current], waiting: [] });
    expect(changes()).toBe(0);
    h.directSeen({ running: [current], waiting: [] });
    expect(changes()).toBe(0);
    h.directSeen({ running: [], waiting: [] });
    expect(changes()).toBe(1);
    h.directSeen({ running: [], waiting: [] });
    expect(changes()).toBe(1);
  });
});
