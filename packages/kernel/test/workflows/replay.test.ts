import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LINE_MAX_BYTES, startTooBig, lineStart, lineStartBytes, replayPlan, validateWorkflow, type Execution, type BlockTrace, type ValidWorkflow } from "../../src/index.js";

const raw = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "templates", "fr", "widgets", "actus-tech", "workflow.json"), "utf8"));
const r = validateWorkflow(raw);
if (!r.ok) throw new Error(r.error);
const valid: ValidWorkflow = r.valid;

const trace = (id: string, extra: Partial<BlockTrace> = {}): BlockTrace => ({
  id, type: "code", status: "succeeded", start: null, end: null, items: 3, log: [], output: { from: id }, ...extra,
});
const origin = (changes: Record<string, Partial<BlockTrace>> = {}, without: string[] = []): Execution => ({
  version: 1, id: "2026-10-29T08-00-00-000Z", owner: { type: "widget", id: "w" }, trigger: "manual",
  start: "2026-10-29T08:00:00.000Z", end: null, status: "succeeded",
  blocks: valid.order.filter((id) => !without.includes(id)).map((id) => trace(id, changes[id])),
});
const error = (p: ReturnType<typeof replayPlan>) => (p.ok ? "accepté à tort" : p.error);

test("rejouer from resumes relaunches resumes, articles, sortie and reuses pages and top", () => {
  const p = replayPlan(valid, origin({ pages: { items: 8 }, top: { items: 15 } }), "resumes");
  if (!p.ok) throw new Error(p.error);
  expect(p.reruns).toEqual(["resumes", "articles", "sortie"]);
  expect(Object.keys(p.outputs).sort()).toEqual(["pages", "top"]);
  expect(p.outputs.top).toEqual({ from: "top" });
  expect(p.resumed).toEqual({ pages: 8, top: 15 });
});

test("rejouer from a block without a predecessor relaunches all its downstream, reusing nothing", () => {
  const p = replayPlan(valid, origin(), "flux");
  if (!p.ok) throw new Error(p.error);
  expect(p.reruns).toEqual(valid.order);
  expect(p.outputs).toEqual({});
  expect(p.resumed).toEqual({});
});

test("refus : origine introuvable", () => {
  expect(error(replayPlan(valid, null, "resumes"))).toBe("Rejeu impossible : exécution introuvable");
});

test("refusal: block absent from the workflow", () => {
  expect(error(replayPlan(valid, origin(), "fantome"))).toBe("Rejeu impossible : le bloc « fantome » n'est pas dans le workflow");
});

test("refusal: upstream output absent (block not launched)", () => {
  const p = replayPlan(valid, origin({ pages: { status: "not-run", output: undefined } }), "resumes");
  expect(error(p)).toBe("Rejeu impossible : la sortie de « pages » manque dans cette exécution");
});

test("refusal: upstream output failed", () => {
  expect(error(replayPlan(valid, origin({ top: { status: "failed" } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « top » manque dans cette exécution",
  );
});

test("refusal: upstream output reused (the origin is itself a trial)", () => {
  expect(error(replayPlan(valid, origin({ pages: { status: "resumed" } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « pages » manque dans cette exécution",
  );
});

test("refusal: upstream output reused and the trial's origin pruned", () => {
  const attempt = { ...origin({ pages: { status: "resumed", output: undefined } }), id: "e1-attempt", attempt: { start: "resumes", origin: "reel" } };
  expect(error(replayPlan(valid, attempt, "resumes", []))).toBe("Rejeu impossible : la sortie de « pages » manque dans cette exécution");
});

const attemptOf = (id: string, from: string, changes: Record<string, Partial<BlockTrace>>): Execution => ({
  ...origin(changes), id, trigger: "replay", attempt: { start: "resumes", origin: from },
});
const resumedWithout = { status: "resumed", output: undefined } as const;

test("rejouer from the same block starting from a trial reuses the outputs of its origin, which it names", () => {
  const real = { ...origin({ pages: { items: 8, output: "p-reel" }, top: { items: 15, output: "t-reel" } }), id: "reel" };
  const attempt = attemptOf("e1-attempt", "reel", { pages: { ...resumedWithout, items: 8 }, top: { ...resumedWithout, items: 15 } });
  const p = replayPlan(valid, attempt, "resumes", [real]);
  if (!p.ok) throw new Error(p.error);
  expect(p.reruns).toEqual(["resumes", "articles", "sortie"]);
  expect(p.outputs).toEqual({ pages: "p-reel", top: "t-reel" });
  expect(p.resumed).toEqual({ pages: 8, top: 15 });
  expect(p.origin).toBe("reel");
});

test("a trial of a trial goes back up the chain to the real run", () => {
  const real = { ...origin({ top: { output: "t-reel" }, pages: { output: "p-reel" } }), id: "reel" };
  const e1 = attemptOf("e1-attempt", "reel", { top: resumedWithout, pages: resumedWithout });
  const e2 = attemptOf("e2-attempt", "e1-attempt", { top: resumedWithout, pages: resumedWithout });
  const p = replayPlan(valid, e2, "resumes", [e1, real]);
  if (!p.ok) throw new Error(p.error);
  expect(p.outputs).toEqual({ pages: "p-reel", top: "t-reel" });
  expect(p.origin).toBe("reel");
});

test("mixed outputs (relaunched by the trial, reused from its origin): the named origin is the trial", () => {
  const real = { ...origin({ top: { output: "t-reel" } }), id: "reel" };
  // The trial started from « a-resumer »: top is reused, pages ran in the trial.
  const e1 = attemptOf("e1-attempt", "reel", { stream: resumedWithout, unique: resumedWithout, sort: resumedWithout, top: resumedWithout, pages: { output: "p-attempt" } });
  const p = replayPlan(valid, e1, "resumes", [real]);
  if (!p.ok) throw new Error(p.error);
  expect(p.outputs).toEqual({ pages: "p-attempt", top: "t-reel" });
  expect(p.origin).toBe("e1-attempt");
});

test("refusal: output reused from the trial's origin truncated", () => {
  const real = { ...origin({ top: { outputTruncated: true, output: "[{…" } }), id: "reel" };
  const attempt = attemptOf("e1-attempt", "reel", { top: resumedWithout, pages: resumedWithout });
  expect(error(replayPlan(valid, attempt, "resumes", [real]))).toBe("Rejeu impossible : la sortie de « top » a été tronquée dans cette exécution");
});

test("refusal: upstream output succeeded but without a kept output", () => {
  expect(error(replayPlan(valid, origin({ pages: { output: undefined } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « pages » manque dans cette exécution",
  );
});

test("refusal: upstream output truncated", () => {
  expect(error(replayPlan(valid, origin({ top: { outputTruncated: true, output: "[{…" } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « top » a été tronquée dans cette exécution",
  );
});

test("refusal: block added upstream since the run", () => {
  expect(error(replayPlan(valid, origin({}, ["pages"]), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « pages » manque dans cette exécution",
  );
});

test("a partial upstream output is reused", () => {
  const p = replayPlan(valid, origin({ pages: { status: "partial" } }), "resumes");
  expect(p.ok).toBe(true);
});

test("headTooBig measures the start line with the outputs to reuse", () => {
  const o = { previous: null, now: "2026-10-29T08:00:00.000Z", config: null, workflow: { blocks: [], links: [], order: [] } };
  const replay = (outputs: Record<string, unknown>) => ({ ...o, replay: { reruns: ["b"], outputs } });
  expect(startTooBig(o)).toBe(false);
  expect(startTooBig(replay({ a: "x".repeat(1024) }))).toBe(false);
  expect(startTooBig(replay({ a: "x".repeat(LINE_MAX_BYTES) }))).toBe(true);
  expect(lineStartBytes(replay({}))).toBeGreaterThan(lineStartBytes(o));
  // The measure is that of the line actually sent, to the byte (é counts two bytes).
  const line = replay({ a: "é".repeat(1000) });
  expect(lineStartBytes(line)).toBe(Buffer.byteLength(lineStart(line)));
  expect(JSON.parse(lineStart(line)).replay).toEqual({ reruns: ["b"], outputs: { a: "é".repeat(1000) } });
  // Without replay, the line is the earlier one: no `replay` key.
  expect("replay" in JSON.parse(lineStart(o))).toBe(false);
});
