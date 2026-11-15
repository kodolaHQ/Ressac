import { z } from "zod";

// Gemma's page plan: its shape (zod), the small language of references and their evaluation. Pure: no input-output,
// nothing is ever evaluated as code; references only read own properties.

export const MAX_OPERATIONS = 4;
export const MAX_PAGE_BLOCKS = 40;
export const PAGE_DEPTH = 2;
export const REFERENCE_MAX = 300;
const PROPS_MAX = 20;
const KEEP_MAX = 200;
export const NO_VALUE = "(sans valeur)";

export type Operation =
  | { op: "count" }
  | { op: "sort"; field: string; desc: boolean }
  | { op: "keep"; n: number }
  | { op: "filter"; field: string; comparison: "=" | "~" | ">" | "<"; value: string | number }
  | { op: "group"; field: string };
/** `ops`: from the inside to the outside. */
export type Reference = { path: string; ops: Operation[] };
export type Group<T> = { value: string; items: T[] };

// ---- Reading references ----

type Token =
  | { t: "word"; v: string }
  | { t: "number"; v: number }
  | { t: "text"; v: string }
  | { t: "sym"; v: "(" | ")" | "," | "." | "$" | "=" | "~" | ">" | "<" };

const WORD = /^[\p{L}\p{N}_]+$/u;

function split(text: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/u.test(c)) { i++; continue; }
    if ("(),.$=~><".includes(c)) { tokens.push({ t: "sym", v: c as never }); i++; continue; }
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) return "texte entre guillemets non fermé";
      tokens.push({ t: "text", v: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const count = /^-?\d+(?:\.\d+)?(?![\p{L}\p{N}_])/u.exec(text.slice(i));
    if (count) { tokens.push({ t: "number", v: Number(count[0]) }); i += count[0].length; continue; }
    let j = i;
    while (j < text.length && WORD.test(text[j]!)) j++;
    if (j === i) return `caractère inattendu « ${c} »`;
    tokens.push({ t: "word", v: text.slice(i, j) });
    i = j;
  }
  return tokens;
}

class PlanError extends Error {}
const OPERATIONS = ["count", "sort", "keep", "filter", "group"];

class Reader {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}
  private peek() { return this.tokens[this.i]; }
  private sym(v: string): boolean { const j = this.peek(); return j?.t === "sym" && j.v === v; }
  private wait(v: string): void {
    if (!this.sym(v)) throw new PlanError(`« ${v} » attendu`);
    this.i++;
  }
  done(): boolean { return this.i >= this.tokens.length; }

  /** A path of `word` segments separated by dots (whole numbers allowed: list indexes). */
  private segments(): string {
    const chunks: string[] = [];
    for (;;) {
      const j = this.peek();
      let seg: string;
      if (j?.t === "word") seg = j.v;
      else if (j?.t === "number" && Number.isInteger(j.v) && j.v >= 0) seg = String(j.v);
      else throw new PlanError("nom de champ attendu");
      this.i++;
      chunks.push(seg);
      if (!this.sym(".")) break;
      this.i++;
    }
    return chunks.join(".");
  }

  field(): string { return this.segments(); }

  reference(): Reference {
    if (this.sym("$")) { this.i++; return { path: "$", ops: [] }; }
    const j = this.tokens[this.i];
    const next = this.tokens[this.i + 1];
    if (j?.t === "word" && OPERATIONS.includes(j.v) && next?.t === "sym" && next.v === "(") {
      this.i += 2;
      const inner = this.reference();
      const op = this.arguments(j.v);
      this.wait(")");
      inner.ops.push(op);
      if (inner.ops.length > MAX_OPERATIONS) throw new PlanError(`plus de ${MAX_OPERATIONS} opérations imbriquées`);
      return inner;
    }
    return { path: this.segments(), ops: [] };
  }

  private comma(): void { this.wait(","); }

  private arguments(name: string): Operation {
    switch (name) {
      case "count": return { op: "count" };
      case "group": this.comma(); return { op: "group", field: this.field() };
      case "sort": {
        this.comma();
        const field = this.field();
        let desc = false;
        if (this.sym(",")) {
          this.i++;
          const j = this.peek();
          if ((j?.t === "text" || j?.t === "word") && j.v === "desc") { desc = true; this.i++; }
          else throw new PlanError('seul "desc" est permis comme troisième argument de sort');
        }
        return { op: "sort", field: field, desc };
      }
      case "keep": {
        this.comma();
        const j = this.peek();
        if (j?.t !== "number" || !Number.isInteger(j.v) || j.v < 1 || j.v > KEEP_MAX) {
          throw new PlanError(`keep : un entier de 1 à ${KEEP_MAX} est attendu`);
        }
        this.i++;
        return { op: "keep", n: j.v };
      }
      default: {
        this.comma();
        const field = this.field();
        const c = this.peek();
        if (c?.t !== "sym" || !["=", "~", ">", "<"].includes(c.v)) throw new PlanError("filter : = ~ > ou < attendu");
        this.i++;
        const v = this.peek();
        if (v?.t !== "number" && v?.t !== "text" && v?.t !== "word") throw new PlanError("filter : valeur attendue");
        this.i++;
        const comparison = c.v as "=" | "~" | ">" | "<";
        if ((comparison === ">" || comparison === "<") && v.t !== "number") throw new PlanError("filter : un nombre est attendu avec > et <");
        return { op: "filter", field: field, comparison: comparison, value: v.v };
      }
    }
  }
}

export function readReference(text: string): Reference | { error: string } {
  if (typeof text !== "string") return { error: "référence : texte attendu" };
  if (text.length > REFERENCE_MAX) return { error: `référence trop longue (plus de ${REFERENCE_MAX} caractères)` };
  const tokens = split(text);
  if (typeof tokens === "string") return { error: tokens };
  try {
    const reader = new Reader(tokens);
    const ref = reader.reference();
    if (!reader.done()) throw new PlanError("texte en trop après la référence");
    return ref;
  } catch (e) {
    if (e instanceof PlanError) return { error: e.message };
    throw e;
  }
}

// ---- Reading and evaluation ----

/** Value at the end of a path `a.b.0`; `$` is the root. Own properties only (never the prototype, never `length`). */
export function readPath(value: unknown, path: string): unknown {
  if (path === "$") return value;
  let v = value;
  for (const chunk of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    if (Array.isArray(v) && !/^\d+$/.test(chunk)) return undefined;
    if (!Object.hasOwn(v, chunk)) return undefined;
    v = (v as Record<string, unknown>)[chunk];
  }
  return v;
}

const absent = (v: unknown) => v === undefined || v === null;
const primitive = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const normalize = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return collator.compare(String(a), String(b));
}

function countOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function apply(op: Operation, entry: unknown): unknown {
  if (!Array.isArray(entry)) throw new PlanError(`${op.op} : liste attendue`);
  switch (op.op) {
    case "count": return entry.length;
    case "keep": return entry.slice(0, op.n);
    case "sort": {
      const keys = entry.map((e, i) => ({ e, i, k: readPath(e, op.field) }));
      const direction = op.desc ? -1 : 1;
      keys.sort((x, y) => {
        const ax = absent(x.k) || !primitive(x.k), ay = absent(y.k) || !primitive(y.k);
        if (ax || ay) return ax === ay ? x.i - y.i : ax ? 1 : -1;
        return direction * compare(x.k, y.k) || x.i - y.i;
      });
      return keys.map((c) => c.e);
    }
    case "filter": {
      const { field, comparison, value } = op;
      const searches = comparison === "~" ? normalize(String(value)) : "";
      return entry.filter((e) => {
        const v = readPath(e, field);
        if (!primitive(v)) return false;
        if (comparison === "~") return normalize(String(v)).includes(searches);
        if (comparison === "=") return String(v) === String(value);
        const n = countOf(v);
        return n !== null && (comparison === ">" ? n > (value as number) : n < (value as number));
      });
    }
    case "group": {
      const groups = new Map<string, unknown[]>();
      for (const e of entry) {
        const v = readPath(e, op.field);
        const key = primitive(v) && v !== "" ? String(v) : NO_VALUE;
        const g = groups.get(key);
        if (g) g.push(e);
        else groups.set(key, [e]);
      }
      return [...groups].map(([value, items]): Group<unknown> => ({ value: value, items }));
    }
  }
}

/** Computes a reference on the results, without ever modifying them. */
export function evaluate(ref: Reference, results: unknown): { value: unknown } | { error: string } {
  let value = readPath(results, ref.path);
  if (value === undefined) return { error: `chemin absent : ${ref.path}` };
  try {
    for (const op of ref.ops) value = apply(op, value);
  } catch (e) {
    if (e instanceof PlanError) return { error: e.message };
    throw e;
  }
  return { value: value };
}

// ---- The plan ----

export type PlanBlock = { component: string; props: Record<string, unknown>; blocks?: PlanBlock[]; left?: PlanBlock[]; right?: PlanBlock[] };
export type PlanPage = { blocks: PlanBlock[] };

const PlanBlockSchema: z.ZodType<PlanBlock> = z.lazy(() =>
  z.object({
    component: z.string().regex(/^[a-z0-9-]{1,40}$/),
    props: z.record(z.string(), z.unknown()).refine((p) => Object.keys(p).length <= PROPS_MAX, `${PROPS_MAX} propriétés au plus`),
    blocks: z.array(PlanBlockSchema).optional(),
    left: z.array(PlanBlockSchema).optional(),
    right: z.array(PlanBlockSchema).optional(),
  }),
);

const CONTAINERS = ["group", "columns"];

/** Total number of blocks, and greatest nesting depth of containers (the page does not count). */
function measure(blocks: PlanBlock[], level: number): { total: number; tooMuch: boolean } {
  let total = 0;
  let too = false;
  for (const b of blocks) {
    total++;
    const children = [b.blocks, b.left, b.right].filter((l): l is PlanBlock[] => l !== undefined);
    if (CONTAINERS.includes(b.component) || children.length > 0) {
      if (level >= PAGE_DEPTH) too = true;
    }
    for (const list of children) {
      const m = measure(list, level + 1);
      total += m.total;
      too ||= m.tooMuch;
    }
  }
  return { total, tooMuch: too };
}

export const PlanPage = z
  .object({ blocks: z.array(PlanBlockSchema).min(1) })
  .superRefine((plan, ctx) => {
    const { total, tooMuch: too } = measure(plan.blocks, 0);
    if (total > MAX_PAGE_BLOCKS) ctx.addIssue({ code: "custom", message: `plus de ${MAX_PAGE_BLOCKS} blocs` });
    if (too) ctx.addIssue({ code: "custom", message: `blocs imbriqués sur plus de ${PAGE_DEPTH} niveaux` });
  });
