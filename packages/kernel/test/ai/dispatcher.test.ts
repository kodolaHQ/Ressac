import { expect, test, vi } from "vitest";
import { createAiDispatcher, AI_ABANDONED, AI_SIMULTANEOUS } from "../../src/ai/dispatcher.js";

/** A fake AI: each call waits to be finished from the outside. */
function fakeAi() {
  const log: string[] = [];
  const running: { name: string; finish: (v?: unknown) => void; fail: (e: Error) => void }[] = [];
  let inFlight = 0;
  let max = 0;
  const call = (name: string) =>
    new Promise<unknown>((ok, ko) => {
      log.push(name);
      max = Math.max(max, ++inFlight);
      const end = (f: () => void) => () => {
        inFlight--;
        f();
      };
      running.push({ name: name, finish: (v) => end(() => ok(v ?? name))(), fail: (e) => end(() => ko(e))() });
    });
  return {
    log: log,
    running: running,
    max: () => max,
    ai: {
      gemma: (o: { prompt: string }) => call(`gemma ${o.prompt}`),
    },
    /** Finishes the oldest in-flight call. */
    finishFirst: async (error?: Error) => {
      const a = running.shift()!;
      if (error) a.fail(error);
      else a.finish();
      await new Promise((r) => setImmediate(r));
    },
  };
}

const wait = () => new Promise((r) => setImmediate(r));

test("AI_SIMULTANEOUS vaut 4", () => {
  expect(AI_SIMULTANEOUS).toBe(4);
});

test("two runs: the short one's call goes through between two calls of the long one", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ai, { concurrent: 1 });
  const lengthy = r.for("veille:2026-10-29T10:00:00.000Z");
  const short = r.for("meteo:2026-10-29T10:01:00.000Z");
  const calls = [lengthy.gemma({ prompt: "L1" }), lengthy.gemma({ prompt: "L2" }), lengthy.gemma({ prompt: "L3" })];
  await wait();
  calls.push(short.gemma({ prompt: "C1" }));
  await wait();
  expect(f.log).toEqual(["gemma L1"]);
  for (let i = 0; i < 4; i++) await f.finishFirst();
  expect(f.log).toEqual(["gemma L1", "gemma L2", "gemma C1", "gemma L3"]);
  expect(await Promise.all(calls)).toEqual(["gemma L1", "gemma L2", "gemma L3", "gemma C1"]);
});

test("never more than 4 calls in flight", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ai);
  const calls: Promise<unknown>[] = [];
  for (const key of ["a", "b", "c"]) for (let i = 0; i < 4; i++) calls.push(r.for(key).gemma({ prompt: `${key}${i}` }));
  await wait();
  expect(f.running).toHaveLength(4);
  while (f.running.length) await f.finishFirst();
  await Promise.all(calls);
  expect(f.log).toHaveLength(12);
  expect(f.max()).toBe(4);
  // The four of « a » leave right away; then « b » and « c » are served in turn.
  expect(f.log.slice(4, 8)).toEqual(["gemma b0", "gemma c0", "gemma b1", "gemma c1"]);
});

test("a failing call does not stop its queue", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ai, { concurrent: 1 });
  const ai = r.for("x");
  const first = ai.gemma({ prompt: "1" });
  const second = ai.gemma({ prompt: "2" });
  await wait();
  const denial = expect(first).rejects.toThrow("Gemma indisponible");
  await f.finishFirst(new Error("Gemma indisponible"));
  await denial;
  await f.finishFirst();
  expect(await second).toBe("gemma 2");
});

test("a call that throws right away does not stop its queue", async () => {
  let n = 0;
  const r = createAiDispatcher(
    {
      gemma: () => {
        n++;
        if (n === 1) throw new Error("tout de suite");
        return Promise.resolve("ok");
      },
    },
    { concurrent: 1 },
  );
  const ai = r.for("x");
  await expect(ai.gemma({ prompt: "1" })).rejects.toThrow("tout de suite");
  expect(await ai.gemma({ prompt: "2" })).toBe("ok");
});

test("oublier: the run's queued calls are refused without leaving, like those that come after", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ai, { concurrent: 1 });
  const a = r.for("a");
  const b = r.for("b");
  const a1 = a.gemma({ prompt: "a1" });
  const a2 = a.gemma({ prompt: "a2" });
  const b1 = b.gemma({ prompt: "b1" });
  await wait();
  const denial = expect(a2).rejects.toThrow(AI_ABANDONED);
  a.forget();
  await denial;
  await expect(a.gemma({ prompt: "a3" })).rejects.toThrow(AI_ABANDONED);
  // The call already in flight ends normally; the slot then goes to « b ».
  await f.finishFirst();
  expect(await a1).toBe("gemma a1");
  await f.finishFirst();
  expect(await b1).toBe("gemma b1");
  expect(f.log).toEqual(["gemma a1", "gemma b1"]);
});

test("4 in flight, 2 widgets queued, then a priority action: the freed slot goes to the action", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ai);
  const calls: Promise<unknown>[] = [];
  for (let i = 0; i < 4; i++) calls.push(r.for(`w${i}`).gemma({ prompt: `w${i}` }));
  calls.push(r.for("w4").gemma({ prompt: "w4" }), r.for("w5").gemma({ prompt: "w5" }));
  await wait();
  calls.push(r.for("action:a", { priority: true }).gemma({ prompt: "a1" }));
  await wait();
  expect(f.log).toEqual(["gemma w0", "gemma w1", "gemma w2", "gemma w3"]);
  await f.finishFirst();
  expect(f.log[4]).toBe("gemma a1");
  while (f.running.length) await f.finishFirst();
  await Promise.all(calls);
  expect(f.log.slice(5)).toEqual(["gemma w4", "gemma w5"]);
});

test("without a priority one, the order is today's (existing tests unchanged)", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ai, { concurrent: 1 });
  const calls = [r.for("x").gemma({ prompt: "x1" }), r.for("a").gemma({ prompt: "a1" }), r.for("a").gemma({ prompt: "a2" }), r.for("b").gemma({ prompt: "b1" }), r.for("c").gemma({ prompt: "c1" })];
  await wait();
  while (f.running.length) await f.finishFirst();
  await Promise.all(calls);
  expect(f.log).toEqual(["gemma x1", "gemma a1", "gemma b1", "gemma c1", "gemma a2"]);
});

test("two priority actions share the slots in turn", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ai, { concurrent: 1 });
  const w = r.for("widget");
  const a = r.for("action:a", { priority: true });
  const b = r.for("action:b", { priority: true });
  const calls = [w.gemma({ prompt: "w1" }), w.gemma({ prompt: "w2" })];
  await wait();
  calls.push(a.gemma({ prompt: "a1" }), a.gemma({ prompt: "a2" }), b.gemma({ prompt: "b1" }), b.gemma({ prompt: "b2" }));
  await wait();
  while (f.running.length) await f.finishFirst();
  await Promise.all(calls);
  // w1 was already in flight: it is never interrupted.
  expect(f.log).toEqual(["gemma w1", "gemma a1", "gemma b1", "gemma a2", "gemma b2", "gemma w2"]);
});

test("atStartup called at the real start, not when queued", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ai, { concurrent: 1 });
  const first = r.for("a").gemma({ prompt: "1" });
  const started = vi.fn();
  const second = r.for("b", { priority: true }).gemma({ prompt: "2" }, { onStartup: started });
  await wait();
  expect(started).not.toHaveBeenCalled();
  await f.finishFirst();
  expect(started).toHaveBeenCalledTimes(1);
  expect(f.log).toEqual(["gemma 1", "gemma 2"]);
  await f.finishFirst();
  await Promise.all([first, second]);
});

test("signal raised in the queue: AI_ABANDONED refusal, the AI is not called", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ai, { concurrent: 1 });
  const first = r.for("a").gemma({ prompt: "1" });
  const controller = new AbortController();
  const started = vi.fn();
  const queued = r.for("b", { priority: true }).gemma({ prompt: "2" }, { signal: controller.signal, onStartup: started });
  const after = r.for("c").gemma({ prompt: "3" });
  await wait();
  const denial = expect(queued).rejects.toThrow(AI_ABANDONED);
  controller.abort();
  await denial;
  // Already raised: refused right away.
  await expect(r.for("b").gemma({ prompt: "0" }, { signal: controller.signal })).rejects.toThrow(AI_ABANDONED);
  await f.finishFirst();
  await f.finishFirst();
  await Promise.all([first, after]);
  expect(f.log).toEqual(["gemma 1", "gemma 3"]);
  expect(started).not.toHaveBeenCalled();
});

test("signal raised in flight: passed to the AI", async () => {
  const received: (AbortSignal | undefined)[] = [];
  const r = createAiDispatcher({
    gemma: async (g: { prompt: string; signal?: AbortSignal }) => (received.push(g.signal), "g"),
  });
  const controller = new AbortController();
  await r.for("a").gemma({ prompt: "x" }, { signal: controller.signal });
  expect(received).toEqual([controller.signal]);
});
