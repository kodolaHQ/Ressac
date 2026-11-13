import type { DirectWidget, DirectState, Execution, ResumeExecution } from "@ressac/kernel";
import { beforeEach, expect, test } from "vitest";
import { Executions, forgetRunChoices, type Launcher, type SourceExecutions } from "../../ui/builder/executions.svelte";

const resume = (id: string, attempt = false): ResumeExecution => ({
  id,
  trigger: attempt ? "replay" : "scheduled",
  ...(attempt ? { attempt: { start: "tri", origin: "a" } } : {}),
  start: "2026-10-29T10:00:00.000Z",
  end: "2026-10-29T10:00:01.000Z",
  status: "succeeded",
  blocks: [{ id: "tri", status: "succeeded", items: 1 }],
});
const complete = (r: ResumeExecution): Execution =>
  ({ ...r, version: 1, owner: { type: "widget", id: "w" }, blocks: r.blocks.map((b) => ({ ...b, type: "ai.sort", start: null, end: null, log: [] })) }) as Execution;

function fake(list: ResumeExecution[]) {
  const state = { list: list };
  const requests: string[] = [];
  const source: SourceExecutions = {
    runs: async () => structuredClone(state.list),
    run: async (_w, id) => {
      requests.push(id);
      const r = state.list.find((x) => x.id === id);
      return r ? complete(r) : null;
    },
  };
  return { source, state: state, requests: requests };
}

test("by default, the last real run (not a trial) and its detail", async () => {
  const f = fake([resume("c-attempt", true), resume("b"), resume("a")]);
  const x = new Executions("w", f.source);
  await x.load();
  expect(x.chosen?.id).toBe("b");
  expect(x.detail?.id).toBe("b");
});

test("no real run: nothing chosen", async () => {
  const f = fake([resume("c-attempt", true)]);
  const x = new Executions("w", f.source);
  await x.load();
  expect(x.chosen).toBeNull();
  expect(x.detail).toBeNull();
});

test("choosing a run loads its detail; vanished, we go back to the last real one", async () => {
  const f = fake([resume("c"), resume("b"), resume("a")]);
  const x = new Executions("w", f.source);
  await x.load();
  await x.choose("a");
  expect(x.chosen?.id).toBe("a");
  expect(x.detail?.id).toBe("a");
  f.state.list = [resume("d"), resume("c")];
  await x.load();
  expect(x.chosen?.id).toBe("d");
  expect(x.detail?.id).toBe("d");
});

test("a new real run becomes the default choice; an explicit choice stays", async () => {
  const f = fake([resume("b"), resume("a")]);
  const x = new Executions("w", f.source);
  await x.load();
  f.state.list = [resume("c"), resume("b"), resume("a")];
  await x.load();
  expect(x.chosen?.id).toBe("c");
  await x.choose("b");
  f.state.list = [resume("d"), resume("c"), resume("b"), resume("a")];
  await x.load();
  expect(x.chosen?.id).toBe("b");
});

test("relire without a change does not ask for the detail again", async () => {
  const f = fake([resume("b")]);
  const x = new Executions("w", f.source);
  await x.load();
  await x.load();
  expect(f.requests).toEqual(["b"]);
});

test("detail not found (evicted between the list and the detail): reported, the list is reread once", async () => {
  const f = fake([resume("b"), resume("a")]);
  let lists = 0;
  const source: SourceExecutions = {
    runs: async () => {
      lists++;
      return f.source.runs("w");
    },
    run: async (_w, id) => (id === "b" ? null : f.source.run("w", id)),
  };
  const x = new Executions("w", source);
  await x.load();
  expect(x.notFound).toBe(true);
  expect(x.detail).toBeNull();
  expect(lists).toBe(2);
  await x.choose("a");
  expect(x.notFound).toBe(false);
  expect(x.detail?.id).toBe("a");
});

test("detail in error: not found, no endless wait", async () => {
  const f = fake([resume("b")]);
  const x = new Executions("w", { ...f.source, run: async () => Promise.reject(new Error("canal")) });
  await x.load();
  expect(x.notFound).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Live, « Lancer » and « Rejouer » (task 11).

type Callback = (e: DirectState) => void;
function falseLauncher(f: ReturnType<typeof fake>) {
  const calls: string[] = [];
  const callbacks: Callback[] = [];
  let finish: (() => void) | null = null;
  const launcher: Launcher = {
    direct: async () => ({ running: [], waiting: [] }),
    onLive: (r) => {
      callbacks.push(r);
      return () => callbacks.splice(callbacks.indexOf(r), 1);
    },
    launch: async (id) => {
      calls.push(`lancer ${id}`);
      await new Promise<void>((ok) => (finish = ok));
      f.state.list = [resume("nouvelle"), ...f.state.list];
      return { run: "nouvelle" };
    },
    replay: async (id, execution, block) => {
      calls.push(`rejouer ${id} ${execution} ${block}`);
      if (block === "page") return { ok: false, error: "Rejeu impossible : la sortie de « liens » a été tronquée dans cette exécution" };
      f.state.list = [resume("e-attempt", true), ...f.state.list];
      return { ok: true, run: "e-attempt", status: "succeeded" };
    },
  };
  return { launcher: launcher, calls: calls, emit: (e: DirectState) => callbacks.forEach((r) => r(e)), callbacks: callbacks, finish: () => finish?.() };
}
const directOf = (widget: string, blocks: DirectWidget["blocks"] = {}, start = "d1"): DirectState => ({
  running: [{ widget, kind: "execution", start: start, blocks: blocks }],
  waiting: [],
});
const waitUntil = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => forgetRunChoices([]));

test("busy when a run of this widget is running or waiting; not for another widget", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.launcher);
  const end = x.follow();
  await x.load();
  expect(x.busy).toBe(false);
  l.emit(directOf("autre"));
  expect(x.busy).toBe(false);
  expect(x.live).toBeNull();
  l.emit({ running: [], waiting: ["w"] });
  expect(x.busy).toBe(true);
  l.emit(directOf("w", { tri: { status: "running", items: null } }));
  expect(x.busy).toBe(true);
  expect(x.live?.blocks.tri?.status).toBe("running");
  end();
  expect(l.callbacks).toHaveLength(0);
});

test("occupe when the widget is among the current or waiting ones", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.launcher);
  const end = x.follow();
  await x.load();
  const watch: DirectWidget = { widget: "veille", kind: "execution", start: "d0", blocks: {} };
  l.emit({ running: [watch], waiting: [] });
  expect(x.busy).toBe(false);
  expect(x.live).toBeNull();
  // Two runs at the same time (short lane and long lane): this widget is the second.
  l.emit({ running: [watch, { widget: "w", kind: "attempt", start: "d1", blocks: { tri: { status: "succeeded", items: 2 } } }], waiting: [] });
  expect(x.busy).toBe(true);
  expect(x.live).toMatchObject({ widget: "w", kind: "attempt", start: "d1" });
  l.emit({ running: [watch], waiting: ["autre", "w"] });
  expect(x.busy).toBe(true);
  expect(x.live).toBeNull();
  l.emit({ running: [watch], waiting: ["autre"] });
  expect(x.busy).toBe(false);
  end();
});

test("end of the run followed live: list and detail reread, no more stale live", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.launcher);
  x.follow();
  await x.load();
  l.emit(directOf("w", { tri: { status: "running", items: null } }));
  // The scheduled run is written, the live one stops (unfinished blocks are not relayed at the end).
  f.state.list = [resume("c"), resume("b")];
  l.emit({ running: [], waiting: [] });
  expect(x.live).toBeNull();
  await waitUntil(() => x.detail?.id === "c");
  expect(x.chosen?.id).toBe("c");
  expect(x.detail?.id).toBe("c");
});

test("two runs in a row without a pause in the live: reread too", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.launcher);
  x.follow();
  await x.load();
  l.emit(directOf("w", {}, "d1"));
  f.state.list = [resume("c"), resume("b")];
  l.emit(directOf("w", {}, "d2"));
  await waitUntil(() => x.detail?.id === "c");
  expect(x.detail?.id).toBe("c");
});

test("▶ Lancer: busy during the request (a double click does not relaunch), then the new run is chosen", async () => {
  const f = fake([resume("b"), resume("a")]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.launcher);
  await x.load();
  await x.choose("a");
  const p = x.launch();
  expect(x.busy).toBe(true);
  void x.launch();
  await waitUntil(() => l.calls.length > 0);
  l.finish();
  await p;
  expect(l.calls).toEqual(["lancer w"]);
  expect(x.busy).toBe(false);
  expect(x.chosen?.id).toBe("nouvelle");
  expect(x.detail?.id).toBe("nouvelle");
});

test("▶ Lancer without a returned run ({}): the choice stays", async () => {
  const f = fake([resume("b"), resume("a")]);
  const l = falseLauncher(f);
  l.launcher.launch = async () => ({});
  const x = new Executions("w", f.source, l.launcher);
  await x.load();
  await x.choose("a");
  await x.launch();
  expect(x.chosen?.id).toBe("a");
});

test("Rejouer from a block: the returned trial is chosen; refused, the message stays and nothing changes", async () => {
  const f = fake([resume("b"), resume("a")]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.launcher);
  await x.load();
  await x.choose("a");
  await x.replay("page");
  expect(l.calls).toEqual(["rejouer w a page"]);
  expect(x.denial).toBe("Rejeu impossible : la sortie de « liens » a été tronquée dans cette exécution");
  expect(x.chosen?.id).toBe("a");
  await x.replay("tri");
  expect(l.calls.at(-1)).toBe("rejouer w a tri");
  expect(x.denial).toBeNull();
  expect(x.chosen?.id).toBe("e-attempt");
  expect(x.detail?.id).toBe("e-attempt");
});

test("Rejouer without a chosen run or during a run: no request", async () => {
  const f = fake([]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.launcher);
  x.follow();
  await x.load();
  await x.replay("tri");
  f.state.list = [resume("b")];
  await x.load();
  l.emit({ running: [], waiting: ["w"] });
  await x.replay("tri");
  expect(l.calls).toEqual([]);
});

test("the choice of a run is kept per widget in the window (switching tabs does not lose it)", async () => {
  const f = fake([resume("b"), resume("a")]);
  const x = new Executions("w", f.source);
  await x.load();
  await x.choose("a");
  const y = new Executions("w", f.source);
  await y.load();
  expect(y.chosen?.id).toBe("a");
  expect(new Executions("v", f.source).wanted).toBeNull();
  forgetRunChoices(["v"]);
  expect(new Executions("w", f.source).wanted).toBeNull();
});

// Review of task 11.

test("the initial read of the live does not overwrite a more recent pushed event", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  let render: (e: DirectState) => void = () => {};
  l.launcher.direct = () => new Promise((ok) => (render = ok));
  const x = new Executions("w", f.source, l.launcher);
  x.follow();
  l.emit({ running: [], waiting: [] });
  render(directOf("w"));
  await waitUntil(() => false);
  expect(x.busy).toBe(false);
  expect(x.live).toBeNull();
});

test("Rejouer that fails on the way (channel): the denial says so", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  l.launcher.replay = () => Promise.reject(new Error("canal fermé"));
  const x = new Executions("w", f.source, l.launcher);
  await x.load();
  await x.replay("tri");
  expect(x.denial).toBe("Rejeu impossible : canal fermé");
  expect(x.busy).toBe(false);
});

test("▶ Lancer that fails on the way: nothing wrongly chosen, no longer busy", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  l.launcher.launch = () => Promise.reject(new Error("canal fermé"));
  const error = console.error;
  console.error = () => {};
  try {
    const x = new Executions("w", f.source, l.launcher);
    await x.load();
    await x.launch();
    expect(x.busy).toBe(false);
    expect(x.chosen?.id).toBe("b");
  } finally {
    console.error = error;
  }
});

test("▶ Lancer that returns the last real run: the default choice resumes, the following ones follow it", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  l.launcher.launch = async () => {
    f.state.list = [resume("nouvelle"), ...f.state.list];
    return { run: "nouvelle" };
  };
  const x = new Executions("w", f.source, l.launcher);
  await x.load();
  await x.launch();
  expect(x.chosen?.id).toBe("nouvelle");
  expect(x.wanted).toBeNull();
  f.state.list = [resume("scheduled"), ...f.state.list];
  await x.load();
  expect(x.chosen?.id).toBe("scheduled");
});

test("a choice made by another builder of the widget (tab left during Lancer) is picked up again on reload", async () => {
  const f = fake([resume("b"), resume("a")]);
  const y = new Executions("w", f.source);
  await y.load();
  const x = new Executions("w", f.source);
  await x.choose("a");
  await y.load();
  expect(y.chosen?.id).toBe("a");
});
