import type { z } from "zod";
import { say } from "../i18n.js";
import { BLOCK_REGISTRY } from "./blocks/index.js";
import { invalidWorkflowPrefix, Workflow, type OutputKind } from "./schema.js";

export type ValidWorkflow = {
  /** The workflow, params filled with the default values. */
  workflow: Workflow;
  /** Run order: topological sort, ties broken in the order of the `blocks` array. */
  order: string[];
  predecessors: Record<string, string[]>;
  output: { id: string; to: OutputKind };
};

/**
 * What the owner declares and that changes the rules: `sources.web`, `harvest.maxDurationMinutes`, its kind (an
 * action returns a page, a widget does not) and, for an action, whether it declares a `input`.
 */
export type ValidationContext = { web: boolean; maxDurationMinutes: number | null; owner: "widget" | "action"; input: boolean; /** The language of the messages; English without it. */ locale?: string };

/** A widget without `web` or maximum duration: the rules from before. */
export const DEFAULT_CONTEXT: ValidationContext = { web: false, maxDurationMinutes: null, owner: "widget", input: false };

export const OUTPUT_PAGE_DENIED = (locale: string) => say(locale, "workflows-val-output-page-denied");
export const OUTPUT_PAGE_REQUIRED = (locale: string) => say(locale, "workflows-val-output-page-required");
export const STREAMING_ACTION = (locale: string) => say(locale, "workflows-val-streaming-action");

/** Refusal of a `web.search` block in a widget that does not declare `"web": true`. */
export const WEB_REQUIRED = (locale: string) => say(locale, "workflows-val-web-required");

/** The `budgetSeconds` of a block without a maximum duration of the widget. */
const BUDGET_MAX_SECONDS = 170;

/** `block`: the id of the block concerned, when the error targets one. */
export type ValidationResult = { ok: true; valid: ValidWorkflow } | { ok: false; error: string; block?: string };

const ERROR_LENGTH_MAX = 300;

/** A validation error, prefixed and bounded. */
export function workflowError(locale: string, cause: string, block?: string): { ok: false; error: string; block?: string } {
  const text = invalidWorkflowPrefix(locale) + cause;
  const error = text.length > ERROR_LENGTH_MAX ? text.slice(0, ERROR_LENGTH_MAX - 1) + "…" : text;
  return block === undefined ? { ok: false, error: error } : { ok: false, error: error, block: block };
}

const TYPES: Record<string, string> = {
  string: "workflows-val-type-string",
  number: "workflows-val-type-number",
  int: "workflows-val-type-int",
  boolean: "workflows-val-type-boolean",
  array: "workflows-val-type-array",
  object: "workflows-val-type-object",
  record: "workflows-val-type-object",
};

/**
 * The message of a zod problem in `locale`, for the common cases. A message written in a schema is a message id
 * (`id` or `id:value`): said in `locale`; an unforeseen case keeps zod's text.
 */
function problemText(p: z.core.$ZodIssue, locale: string): string {
  if (p.message.startsWith("workflows-")) {
    const [id, ...value] = p.message.split(":");
    return say(locale, id!, { value: value.join(":") });
  }
  if (!/^(Invalid|Too (big|small)|Unrecognized)/.test(p.message)) return p.message;
  const i = p as z.core.$ZodIssue & Record<string, unknown>;
  // The number is also given as text: Fluent would group its digits.
  const count = (id: string, n: unknown) => say(locale, id, { n: Number(n), text: String(n) });
  switch (p.code) {
    case "invalid_type": {
      const type = TYPES[String(i.expected)];
      const expected = type ? say(locale, type) : say(locale, "workflows-val-type-other", { expected: String(i.expected) });
      return p.message.endsWith("received undefined") ? say(locale, "workflows-val-missing", { expected }) : expected;
    }
    case "too_big": {
      const n = i.maximum;
      if (i.origin === "array") return count("workflows-val-max-items", n);
      if (i.origin === "string") return count("workflows-val-max-chars", n);
      return say(locale, i.inclusive === false ? "workflows-val-less-than" : "workflows-val-at-most", { n: String(n) });
    }
    case "too_small": {
      const n = i.minimum;
      if (i.origin === "array") return count("workflows-val-min-items", n);
      if (i.origin === "string") return Number(n) === 1 ? say(locale, "workflows-val-empty") : count("workflows-val-min-chars", n);
      return say(locale, i.inclusive === false ? "workflows-val-greater-than" : "workflows-val-at-least", { n: String(n) });
    }
    case "invalid_value": {
      const values = (Array.isArray(i.values) ? i.values : []).map((v) => JSON.stringify(v)).join(", ");
      return say(locale, Array.isArray(i.values) && i.values.length === 1 ? "workflows-val-one-value" : "workflows-val-one-of", { values });
    }
    case "unrecognized_keys":
      return say(locale, "workflows-val-unknown-key");
    default:
      return p.message;
  }
}

/** First zod problem, in the form « <path> : <message> ». */
function firstProblem(error: z.ZodError, locale: string, root?: string): string {
  const p = error.issues[0]!;
  const path = p.path.map(String);
  if (p.code === "unrecognized_keys") path.push(...p.keys.slice(0, 1));
  const message = problemText(p, locale);
  const name = [...(root ? [root] : []), ...path].join(".");
  return name ? say(locale, "workflows-val-at", { name, message }) : message;
}

/** A cycle among the remaining blocks, named « a → b → a », starting from the first in the array order. */
function nameCycle(remaining: string[], predecessors: Record<string, string[]>): { text: string; first: string } {
  const rest = new Set(remaining);
  const seen: string[] = [];
  let current = remaining[0]!;
  while (!seen.includes(current)) {
    seen.push(current);
    current = predecessors[current]!.find((p) => rest.has(p))!;
  }
  // Going up the predecessors, we get the cycle backwards.
  const cycle = seen.slice(seen.indexOf(current)).reverse();
  const start = cycle.reduce((m, id, i) => (remaining.indexOf(id) < remaining.indexOf(cycle[m]!) ? i : m), 0);
  const running = [...cycle.slice(start), ...cycle.slice(0, start)];
  return { text: [...running, running[0]!].join(" → "), first: running[0]! };
}

export function validateWorkflow(raw: unknown, ctx: ValidationContext = DEFAULT_CONTEXT): ValidationResult {
  const locale = ctx.locale ?? "en";
  const fail = (cause: string, block?: string) => workflowError(locale, cause, block);
  const parsed = Workflow.safeParse(raw);
  if (!parsed.success) return fail(firstProblem(parsed.error, locale));
  const workflow = parsed.data;

  const ids = new Set<string>();
  for (const b of workflow.blocks) {
    if (ids.has(b.id)) return fail(say(locale, "workflows-val-duplicate-id", { id: b.id }), b.id);
    ids.add(b.id);
  }

  for (const b of workflow.blocks) {
    const definition = BLOCK_REGISTRY.get(b.type);
    if (!definition) return fail(say(locale, "workflows-val-unknown-type", { type: b.type }), b.id);
    if (b.type === "web.search" && !ctx.web) return fail(WEB_REQUIRED(locale), b.id);
    if (definition.perItem === "no" && "perItem" in b.params) {
      return fail(say(locale, "workflows-val-per-item-no", { id: b.id, type: b.type }), b.id);
    }
    const params = definition.params.safeParse(b.params);
    if (!params.success) return fail(firstProblem(params.error, locale, b.id), b.id);
    b.params = params.data as Record<string, unknown>;
    const p = b.params;
    const budgetMax = ctx.maxDurationMinutes ? ctx.maxDurationMinutes * 60 : BUDGET_MAX_SECONDS;
    if (typeof p.budgetSeconds === "number" && p.budgetSeconds > budgetMax) {
      return fail(say(locale, "workflows-val-budget", { id: b.id, max: String(budgetMax) }), b.id);
    }
    if (b.type !== "list.new" && p.keepDays !== undefined && p.reuse === undefined) {
      return fail(say(locale, "workflows-val-keepdays-reuse", { id: b.id }), b.id);
    }
  }

  const predecessors: Record<string, string[]> = Object.fromEntries(workflow.blocks.map((b) => [b.id, []]));
  for (const l of workflow.links) {
    for (const end of [l.from, l.to]) {
      if (!ids.has(end)) {
        const other = end === l.from ? l.to : l.from;
        return fail(say(locale, "workflows-val-link-absent", { id: end }), ids.has(other) ? other : undefined);
      }
    }
    if (!predecessors[l.to]!.includes(l.from)) predecessors[l.to]!.push(l.from);
  }

  const outputs = workflow.blocks.filter((b) => b.type === "output");
  if (outputs.length === 0) return fail(say(locale, "workflows-val-no-output"));
  if (outputs.length > 1) return fail(say(locale, "workflows-val-many-outputs", { ids: outputs.map((b) => b.id).join(", ") }));

  const outputParams = outputs[0]!.params as { to: OutputKind; live?: boolean };
  if (ctx.owner === "widget" && outputParams.to === "page") return fail(OUTPUT_PAGE_DENIED(locale), outputs[0]!.id);
  if (ctx.owner === "action") {
    if (outputParams.to !== "page") return fail(OUTPUT_PAGE_REQUIRED(locale), outputs[0]!.id);
    if (outputParams.live === true) return fail(STREAMING_ACTION(locale), outputs[0]!.id);
  }

  // Kahn's sort: at each round, the first block (in array order) all of whose predecessors are placed.
  const order: string[] = [];
  const places = new Set<string>();
  let remaining = workflow.blocks.map((b) => b.id);
  while (remaining.length > 0) {
    const next = remaining.find((id) => predecessors[id]!.every((p) => places.has(p)));
    if (next === undefined) {
      const cycle = nameCycle(remaining, predecessors);
      return fail(say(locale, "workflows-val-cycle", { cycle: cycle.text }), cycle.first);
    }
    order.push(next);
    places.add(next);
    remaining = remaining.filter((id) => id !== next);
  }

  // Last: the other errors (params, links, cycle) come first.
  for (const b of workflow.blocks) {
    const entry = BLOCK_REGISTRY.get(b.type)!.input;
    const required = entry === "required" || (entry === "perItem" && b.params.perItem === true);
    if (required && predecessors[b.id]!.length === 0) return fail(say(locale, "workflows-val-missing-input", { id: b.id }), b.id);
  }

  const to = outputParams.to;
  return { ok: true, valid: { workflow, order: order, predecessors: predecessors, output: { id: outputs[0]!.id, to: to } } };
}

/** The workflow of a widget that only has `harvest.mjs`: harvest → output. */
export function implicitWorkflow(): Workflow {
  return {
    version: 1,
    blocks: [
      { id: "harvest", type: "code", position: { x: 0, y: 0 }, params: { source: "harvest.mjs", call: "harvest" } },
      { id: "output", type: "output", position: { x: 0, y: 0 }, params: { to: "widget" } },
    ],
    links: [{ from: "harvest", to: "output" }],
  };
}
