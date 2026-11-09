import type { z } from "zod";
import { BLOCK_REGISTRY } from "./blocks/index.js";
import { INVALID_WORKFLOW_PREFIX, Workflow, type OutputKind } from "./schema.js";

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
export type ValidationContext = { web: boolean; maxDurationMinutes: number | null; owner: "widget" | "action"; input: boolean };

/** A widget without `web` or maximum duration: the rules from before. */
export const DEFAULT_CONTEXT: ValidationContext = { web: false, maxDurationMinutes: null, owner: "widget", input: false };

export const OUTPUT_PAGE_DENIED = 'output : to "page" seulement dans une action';
export const OUTPUT_PAGE_REQUIRED = 'output : une action rend une page (to: "page")';
export const STREAMING_ACTION = "output.live : pas dans une action";

/** Refusal of a `web.search` block in a widget that does not declare `"web": true`. */
export const WEB_REQUIRED = 'web.search : le widget doit déclarer "web": true';

/** The `budgetSeconds` of a block without a maximum duration of the widget. */
const BUDGET_MAX_SECONDS = 170;

/** `block`: the id of the block concerned, when the error targets one. */
export type ValidationResult = { ok: true; valid: ValidWorkflow } | { ok: false; error: string; block?: string };

const ERROR_LENGTH_MAX = 300;

/** A validation error, prefixed and bounded. */
export function workflowError(cause: string, block?: string): { ok: false; error: string; block?: string } {
  const text = INVALID_WORKFLOW_PREFIX + cause;
  const error = text.length > ERROR_LENGTH_MAX ? text.slice(0, ERROR_LENGTH_MAX - 1) + "…" : text;
  return block === undefined ? { ok: false, error: error } : { ok: false, error: error, block: block };
}

const TYPES: Record<string, string> = {
  string: "texte attendu",
  number: "nombre attendu",
  int: "nombre entier attendu",
  boolean: "booléen attendu",
  array: "liste attendue",
  object: "objet attendu",
  record: "objet attendu",
};
const plural = (n: unknown, word: string) => `${String(n)} ${word}${Number(n) > 1 ? "s" : ""}`;

/**
 * The message of a zod problem in short French, for the common cases. A message written in a schema (already in
 * French) is kept; an unforeseen case keeps zod's text.
 */
function inFrench(p: z.core.$ZodIssue): string {
  if (!/^(Invalid|Too (big|small)|Unrecognized)/.test(p.message)) return p.message;
  const i = p as z.core.$ZodIssue & Record<string, unknown>;
  switch (p.code) {
    case "invalid_type": {
      const expected = TYPES[String(i.expected)] ?? `${String(i.expected)} attendu`;
      return /received undefined$/.test(p.message) ? `manquant (${expected})` : expected;
    }
    case "too_big": {
      const n = i.maximum;
      if (i.origin === "array") return `${plural(n, "élément")} au plus`;
      if (i.origin === "string") return `${plural(n, "caractère")} au plus`;
      return i.inclusive === false ? `doit être inférieur à ${String(n)}` : `${String(n)} au plus`;
    }
    case "too_small": {
      const n = i.minimum;
      if (i.origin === "array") return `au moins ${plural(n, "élément")}`;
      if (i.origin === "string") return Number(n) === 1 ? "vide" : `au moins ${plural(n, "caractère")}`;
      return i.inclusive === false ? `doit être supérieur à ${String(n)}` : `au moins ${String(n)}`;
    }
    case "invalid_value": {
      const values = (Array.isArray(i.values) ? i.values : []).map((v) => JSON.stringify(v)).join(", ");
      return Array.isArray(i.values) && i.values.length === 1 ? `${values} attendu` : `une valeur parmi ${values} attendue`;
    }
    case "unrecognized_keys":
      return "paramètre inconnu";
    default:
      return p.message;
  }
}

/** First zod problem, in the form « <chemin> : <message> ». */
function firstProblem(error: z.ZodError, root?: string): string {
  const p = error.issues[0]!;
  const path = [...p.path.map(String)];
  if (p.code === "unrecognized_keys") path.push(...p.keys.slice(0, 1));
  const message = inFrench(p);
  const name = [...(root ? [root] : []), ...path].join(".");
  return name ? `${name} : ${message}` : message;
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
  const lu = Workflow.safeParse(raw);
  if (!lu.success) return workflowError(firstProblem(lu.error));
  const workflow = lu.data;

  const ids = new Set<string>();
  for (const b of workflow.blocks) {
    if (ids.has(b.id)) return workflowError(`id de bloc en double : ${b.id}`, b.id);
    ids.add(b.id);
  }

  for (const b of workflow.blocks) {
    const definition = BLOCK_REGISTRY.get(b.type);
    if (!definition) return workflowError(`type inconnu : ${b.type}`, b.id);
    if (b.type === "web.search" && !ctx.web) return workflowError(WEB_REQUIRED, b.id);
    if (definition.perItem === "no" && "perItem" in b.params) {
      return workflowError(`${b.id}.perItem : le type ${b.type} ne travaille pas élément par élément`, b.id);
    }
    const params = definition.params.safeParse(b.params);
    if (!params.success) return workflowError(firstProblem(params.error, b.id), b.id);
    b.params = params.data as Record<string, unknown>;
    const p = b.params;
    const budgetMax = ctx.maxDurationMinutes ? ctx.maxDurationMinutes * 60 : BUDGET_MAX_SECONDS;
    if (typeof p.budgetSeconds === "number" && p.budgetSeconds > budgetMax) {
      return workflowError(`${b.id}.budgetSeconds : ${budgetMax} au plus`, b.id);
    }
    if (b.type !== "list.new" && p.keepDays !== undefined && p.reuse === undefined) {
      return workflowError(`${b.id}.keepDays : seulement avec reuse`, b.id);
    }
  }

  const predecessors: Record<string, string[]> = Object.fromEntries(workflow.blocks.map((b) => [b.id, []]));
  for (const l of workflow.links) {
    for (const end of [l.from, l.to]) {
      if (!ids.has(end)) {
        const other = end === l.from ? l.to : l.from;
        return workflowError(`lien vers un bloc absent : ${end}`, ids.has(other) ? other : undefined);
      }
    }
    if (!predecessors[l.to]!.includes(l.from)) predecessors[l.to]!.push(l.from);
  }

  const outputs = workflow.blocks.filter((b) => b.type === "output");
  if (outputs.length === 0) return workflowError("aucune sortie");
  if (outputs.length > 1) return workflowError(`plusieurs sorties : ${outputs.map((b) => b.id).join(", ")}`);

  const outputParams = outputs[0]!.params as { to: OutputKind; live?: boolean };
  if (ctx.owner === "widget" && outputParams.to === "page") return workflowError(OUTPUT_PAGE_DENIED, outputs[0]!.id);
  if (ctx.owner === "action") {
    if (outputParams.to !== "page") return workflowError(OUTPUT_PAGE_REQUIRED, outputs[0]!.id);
    if (outputParams.live === true) return workflowError(STREAMING_ACTION, outputs[0]!.id);
  }

  // Kahn's sort: at each round, the first block (in array order) all of whose predecessors are placed.
  const order: string[] = [];
  const places = new Set<string>();
  let remaining = workflow.blocks.map((b) => b.id);
  while (remaining.length > 0) {
    const next = remaining.find((id) => predecessors[id]!.every((p) => places.has(p)));
    if (next === undefined) {
      const cycle = nameCycle(remaining, predecessors);
      return workflowError(`cycle : ${cycle.text}`, cycle.first);
    }
    order.push(next);
    places.add(next);
    remaining = remaining.filter((id) => id !== next);
  }

  // Last: the other errors (params, links, cycle) come first.
  for (const b of workflow.blocks) {
    const entry = BLOCK_REGISTRY.get(b.type)!.input;
    const required = entry === "required" || (entry === "perItem" && b.params.perItem === true);
    if (required && predecessors[b.id]!.length === 0) return workflowError(`${b.id} : entrée manquante (relie un bloc avant lui)`, b.id);
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
