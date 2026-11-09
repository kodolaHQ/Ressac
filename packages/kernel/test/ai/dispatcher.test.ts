import { expect, test, vi } from "vitest";
import { createAiDispatcher, AI_ABANDONED, AI_SIMULTANEOUS } from "../../src/ai/dispatcher.js";

/** A fake AI: each call waits to be finished from the outside. */
function fakeAi() {
  const log: string[] = [];
  const running: { nom: string; finir: (v?: unknown) => void; echouer: (e: Error) => void }[] = [];
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
      running.push({ nom: name, finir: (v) => end(() => ok(v ?? name))(), echouer: (e) => end(() => ko(e))() });
    });
  return {
    journal: log,
    enCours: running,
    max: () => max,
    ia: {
      kev: (body: { state: unknown; questions: Record<string, unknown> }) => call(`kev ${String(body.state)}`),
      gemma: (o: { prompt: string }) => call(`gemma ${o.prompt}`),
    },
    /** Finishes the oldest in-flight call. */
    finirPremier: async (error?: Error) => {
      const a = running.shift()!;
      if (error) a.echouer(error);
      else a.finir();
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
  const r = createAiDispatcher(f.ia, { simultanes: 1 });
  const lengthy = r.pour("veille:2026-10-29T10:00:00.000Z");
  const short = r.pour("meteo:2026-10-29T10:01:00.000Z");
  const calls = [lengthy.gemma({ prompt: "L1" }), lengthy.gemma({ prompt: "L2" }), lengthy.gemma({ prompt: "L3" })];
  await wait();
  calls.push(short.gemma({ prompt: "C1" }));
  await wait();
  expect(f.journal).toEqual(["gemma L1"]);
  for (let i = 0; i < 4; i++) await f.finirPremier();
  expect(f.journal).toEqual(["gemma L1", "gemma L2", "gemma C1", "gemma L3"]);
  expect(await Promise.all(calls)).toEqual(["gemma L1", "gemma L2", "gemma L3", "gemma C1"]);
});

test("never more than 4 calls in flight", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ia);
  const calls: Promise<unknown>[] = [];
  for (const key of ["a", "b", "c"]) for (let i = 0; i < 4; i++) calls.push(r.pour(key).kev({ state: `${key}${i}`, questions: {} }));
  await wait();
  expect(f.enCours).toHaveLength(4);
  while (f.enCours.length) await f.finirPremier();
  await Promise.all(calls);
  expect(f.journal).toHaveLength(12);
  expect(f.max()).toBe(4);
  // The four of « a » leave right away; then « b » and « c » are served in turn.
  expect(f.journal.slice(4, 8)).toEqual(["kev b0", "kev c0", "kev b1", "kev c1"]);
});

test("a failing call does not stop its queue", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ia, { simultanes: 1 });
  const ai = r.pour("x");
  const first = ai.gemma({ prompt: "1" });
  const second = ai.gemma({ prompt: "2" });
  await wait();
  const denial = expect(first).rejects.toThrow("Gemma indisponible");
  await f.finirPremier(new Error("Gemma indisponible"));
  await denial;
  await f.finirPremier();
  expect(await second).toBe("gemma 2");
});

test("a call that throws right away does not stop its queue", async () => {
  let n = 0;
  const r = createAiDispatcher(
    {
      kev: () => {
        n++;
        if (n === 1) throw new Error("tout de suite");
        return Promise.resolve("ok");
      },
      gemma: async () => "g",
    },
    { simultanes: 1 },
  );
  const ai = r.pour("x");
  await expect(ai.kev({ state: 1, questions: {} })).rejects.toThrow("tout de suite");
  expect(await ai.kev({ state: 2, questions: {} })).toBe("ok");
});

test("oublier: the run's queued calls are refused without leaving, like those that come after", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ia, { simultanes: 1 });
  const a = r.pour("a");
  const b = r.pour("b");
  const a1 = a.gemma({ prompt: "a1" });
  const a2 = a.gemma({ prompt: "a2" });
  const b1 = b.gemma({ prompt: "b1" });
  await wait();
  const denial = expect(a2).rejects.toThrow(AI_ABANDONED);
  a.oublier();
  await denial;
  await expect(a.gemma({ prompt: "a3" })).rejects.toThrow(AI_ABANDONED);
  // The call already in flight ends normally; the slot then goes to « b ».
  await f.finirPremier();
  expect(await a1).toBe("gemma a1");
  await f.finirPremier();
  expect(await b1).toBe("gemma b1");
  expect(f.journal).toEqual(["gemma a1", "gemma b1"]);
});

test("4 in flight, 2 widgets queued, then a priority action: the freed slot goes to the action", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ia);
  const calls: Promise<unknown>[] = [];
  for (let i = 0; i < 4; i++) calls.push(r.pour(`w${i}`).gemma({ prompt: `w${i}` }));
  calls.push(r.pour("w4").gemma({ prompt: "w4" }), r.pour("w5").gemma({ prompt: "w5" }));
  await wait();
  calls.push(r.pour("action:a", { prioritaire: true }).gemma({ prompt: "a1" }));
  await wait();
  expect(f.journal).toEqual(["gemma w0", "gemma w1", "gemma w2", "gemma w3"]);
  await f.finirPremier();
  expect(f.journal[4]).toBe("gemma a1");
  while (f.enCours.length) await f.finirPremier();
  await Promise.all(calls);
  expect(f.journal.slice(5)).toEqual(["gemma w4", "gemma w5"]);
});

test("without a priority one, the order is today's (existing tests unchanged)", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ia, { simultanes: 1 });
  const calls = [r.pour("x").gemma({ prompt: "x1" }), r.pour("a").gemma({ prompt: "a1" }), r.pour("a").gemma({ prompt: "a2" }), r.pour("b").gemma({ prompt: "b1" }), r.pour("c").gemma({ prompt: "c1" })];
  await wait();
  while (f.enCours.length) await f.finirPremier();
  await Promise.all(calls);
  expect(f.journal).toEqual(["gemma x1", "gemma a1", "gemma b1", "gemma c1", "gemma a2"]);
});

test("two priority actions share the slots in turn", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ia, { simultanes: 1 });
  const w = r.pour("widget");
  const a = r.pour("action:a", { prioritaire: true });
  const b = r.pour("action:b", { prioritaire: true });
  const calls = [w.kev({ state: "w1", questions: {} }), w.kev({ state: "w2", questions: {} })];
  await wait();
  calls.push(a.kev({ state: "a1", questions: {} }), a.kev({ state: "a2", questions: {} }), b.kev({ state: "b1", questions: {} }), b.kev({ state: "b2", questions: {} }));
  await wait();
  while (f.enCours.length) await f.finirPremier();
  await Promise.all(calls);
  // w1 was already in flight: it is never interrupted.
  expect(f.journal).toEqual(["kev w1", "kev a1", "kev b1", "kev a2", "kev b2", "kev w2"]);
});

test("auDemarrage called at the real start, not when queued", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ia, { simultanes: 1 });
  const first = r.pour("a").gemma({ prompt: "1" });
  const started = vi.fn();
  const second = r.pour("b", { prioritaire: true }).gemma({ prompt: "2" }, { auDemarrage: started });
  await wait();
  expect(started).not.toHaveBeenCalled();
  await f.finirPremier();
  expect(started).toHaveBeenCalledTimes(1);
  expect(f.journal).toEqual(["gemma 1", "gemma 2"]);
  await f.finirPremier();
  await Promise.all([first, second]);
});

test("signal raised in the queue: AI_ABANDONED refusal, the AI is not called", async () => {
  const f = fakeAi();
  const r = createAiDispatcher(f.ia, { simultanes: 1 });
  const first = r.pour("a").gemma({ prompt: "1" });
  const controller = new AbortController();
  const started = vi.fn();
  const queued = r.pour("b", { prioritaire: true }).gemma({ prompt: "2" }, { signal: controller.signal, auDemarrage: started });
  const after = r.pour("c").gemma({ prompt: "3" });
  await wait();
  const denial = expect(queued).rejects.toThrow(AI_ABANDONED);
  controller.abort();
  await denial;
  // Already raised: refused right away.
  await expect(r.pour("b").kev({ state: 0, questions: {} }, { signal: controller.signal })).rejects.toThrow(AI_ABANDONED);
  await f.finirPremier();
  await f.finirPremier();
  await Promise.all([first, after]);
  expect(f.journal).toEqual(["gemma 1", "gemma 3"]);
  expect(started).not.toHaveBeenCalled();
});

test("signal raised in flight: passed to the AI", async () => {
  const received: (AbortSignal | undefined)[] = [];
  const r = createAiDispatcher({
    kev: async (_c: unknown, o?: { signal?: AbortSignal }) => (received.push(o?.signal), "k"),
    gemma: async (g: { prompt: string; signal?: AbortSignal }) => (received.push(g.signal), "g"),
  });
  const controller = new AbortController();
  await r.pour("a").kev({ state: 1, questions: {} }, { signal: controller.signal });
  await r.pour("a").gemma({ prompt: "x" }, { signal: controller.signal });
  expect(received).toEqual([controller.signal, controller.signal]);
});
