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
  | { op: "compter" }
  | { op: "trier"; champ: string; desc: boolean }
  | { op: "garder"; n: number }
  | { op: "filtrer"; champ: string; comparaison: "=" | "~" | ">" | "<"; valeur: string | number }
  | { op: "regrouper"; champ: string };
/** `ops`: from the inside to the outside. */
export type Reference = { chemin: string; ops: Operation[] };
export type Group<T> = { valeur: string; elements: T[] };

// ---- Reading references ----

type Token =
  | { t: "mot"; v: string }
  | { t: "nombre"; v: number }
  | { t: "texte"; v: string }
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
      tokens.push({ t: "texte", v: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const count = /^-?\d+(?:\.\d+)?(?![\p{L}\p{N}_])/u.exec(text.slice(i));
    if (count) { tokens.push({ t: "nombre", v: Number(count[0]) }); i += count[0].length; continue; }
    let j = i;
    while (j < text.length && WORD.test(text[j]!)) j++;
    if (j === i) return `caractère inattendu « ${c} »`;
    tokens.push({ t: "mot", v: text.slice(i, j) });
    i = j;
  }
  return tokens;
}

class PlanError extends Error {}
const OPERATIONS = ["compter", "trier", "garder", "filtrer", "regrouper"];

class Reader {
  private i = 0;
  constructor(private readonly jetons: Token[]) {}
  private pos() { return this.jetons[this.i]; }
  private sym(v: string): boolean { const j = this.pos(); return j?.t === "sym" && j.v === v; }
  private attendre(v: string): void {
    if (!this.sym(v)) throw new PlanError(`« ${v} » attendu`);
    this.i++;
  }
  fini(): boolean { return this.i >= this.jetons.length; }

  /** A path of `mot` segments separated by dots (whole numbers allowed: list indexes). */
  private segments(): string {
    const chunks: string[] = [];
    for (;;) {
      const j = this.pos();
      let seg: string;
      if (j?.t === "mot") seg = j.v;
      else if (j?.t === "nombre" && Number.isInteger(j.v) && j.v >= 0) seg = String(j.v);
      else throw new PlanError("nom de champ attendu");
      this.i++;
      chunks.push(seg);
      if (!this.sym(".")) break;
      this.i++;
    }
    return chunks.join(".");
  }

  champ(): string { return this.segments(); }

  reference(): Reference {
    if (this.sym("$")) { this.i++; return { chemin: "$", ops: [] }; }
    const j = this.jetons[this.i];
    const next = this.jetons[this.i + 1];
    if (j?.t === "mot" && OPERATIONS.includes(j.v) && next?.t === "sym" && next.v === "(") {
      this.i += 2;
      const inner = this.reference();
      const op = this.arguments(j.v);
      this.attendre(")");
      inner.ops.push(op);
      if (inner.ops.length > MAX_OPERATIONS) throw new PlanError(`plus de ${MAX_OPERATIONS} opérations imbriquées`);
      return inner;
    }
    return { chemin: this.segments(), ops: [] };
  }

  private virgule(): void { this.attendre(","); }

  private arguments(name: string): Operation {
    switch (name) {
      case "compter": return { op: "compter" };
      case "regrouper": this.virgule(); return { op: "regrouper", champ: this.champ() };
      case "trier": {
        this.virgule();
        const field = this.champ();
        let desc = false;
        if (this.sym(",")) {
          this.i++;
          const j = this.pos();
          if ((j?.t === "texte" || j?.t === "mot") && j.v === "desc") { desc = true; this.i++; }
          else throw new PlanError('seul "desc" est permis comme troisième argument de trier');
        }
        return { op: "trier", champ: field, desc };
      }
      case "garder": {
        this.virgule();
        const j = this.pos();
        if (j?.t !== "nombre" || !Number.isInteger(j.v) || j.v < 1 || j.v > KEEP_MAX) {
          throw new PlanError(`garder : un entier de 1 à ${KEEP_MAX} est attendu`);
        }
        this.i++;
        return { op: "garder", n: j.v };
      }
      default: {
        this.virgule();
        const field = this.champ();
        const c = this.pos();
        if (c?.t !== "sym" || !["=", "~", ">", "<"].includes(c.v)) throw new PlanError("filtrer : = ~ > ou < attendu");
        this.i++;
        const v = this.pos();
        if (v?.t !== "nombre" && v?.t !== "texte" && v?.t !== "mot") throw new PlanError("filtrer : valeur attendue");
        this.i++;
        const comparison = c.v as "=" | "~" | ">" | "<";
        if ((comparison === ">" || comparison === "<") && v.t !== "nombre") throw new PlanError("filtrer : un nombre est attendu avec > et <");
        return { op: "filtrer", champ: field, comparaison: comparison, valeur: v.v };
      }
    }
  }
}

export function readReference(text: string): Reference | { erreur: string } {
  if (typeof text !== "string") return { erreur: "référence : texte attendu" };
  if (text.length > REFERENCE_MAX) return { erreur: `référence trop longue (plus de ${REFERENCE_MAX} caractères)` };
  const tokens = split(text);
  if (typeof tokens === "string") return { erreur: tokens };
  try {
    const reader = new Reader(tokens);
    const ref = reader.reference();
    if (!reader.fini()) throw new PlanError("texte en trop après la référence");
    return ref;
  } catch (e) {
    if (e instanceof PlanError) return { erreur: e.message };
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
    case "compter": return entry.length;
    case "garder": return entry.slice(0, op.n);
    case "trier": {
      const keys = entry.map((e, i) => ({ e, i, k: readPath(e, op.champ) }));
      const direction = op.desc ? -1 : 1;
      keys.sort((x, y) => {
        const ax = absent(x.k) || !primitive(x.k), ay = absent(y.k) || !primitive(y.k);
        if (ax || ay) return ax === ay ? x.i - y.i : ax ? 1 : -1;
        return direction * compare(x.k, y.k) || x.i - y.i;
      });
      return keys.map((c) => c.e);
    }
    case "filtrer": {
      const { champ: field, comparaison: comparison, valeur: value } = op;
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
    case "regrouper": {
      const groups = new Map<string, unknown[]>();
      for (const e of entry) {
        const v = readPath(e, op.champ);
        const key = primitive(v) && v !== "" ? String(v) : NO_VALUE;
        const g = groups.get(key);
        if (g) g.push(e);
        else groups.set(key, [e]);
      }
      return [...groups].map(([value, elements]): Group<unknown> => ({ valeur: value, elements }));
    }
  }
}

/** Computes a reference on the results, without ever modifying them. */
export function evaluate(ref: Reference, results: unknown): { valeur: unknown } | { erreur: string } {
  let value = readPath(results, ref.chemin);
  if (value === undefined) return { erreur: `chemin absent : ${ref.chemin}` };
  try {
    for (const op of ref.ops) value = apply(op, value);
  } catch (e) {
    if (e instanceof PlanError) return { erreur: e.message };
    throw e;
  }
  return { valeur: value };
}

// ---- The plan ----

export type PlanBlock = { composant: string; props: Record<string, unknown>; blocs?: PlanBlock[]; gauche?: PlanBlock[]; droite?: PlanBlock[] };
export type PlanPage = { blocs: PlanBlock[] };

const PlanBlockSchema: z.ZodType<PlanBlock> = z.lazy(() =>
  z.object({
    composant: z.string().regex(/^[a-z0-9-]{1,40}$/),
    props: z.record(z.string(), z.unknown()).refine((p) => Object.keys(p).length <= PROPS_MAX, `${PROPS_MAX} propriétés au plus`),
    blocs: z.array(PlanBlockSchema).optional(),
    gauche: z.array(PlanBlockSchema).optional(),
    droite: z.array(PlanBlockSchema).optional(),
  }),
);

const CONTAINERS = ["groupe", "colonnes"];

/** Total number of blocks, and greatest nesting depth of containers (the page does not count). */
function measure(blocks: PlanBlock[], level: number): { total: number; trop: boolean } {
  let total = 0;
  let too = false;
  for (const b of blocks) {
    total++;
    const children = [b.blocs, b.gauche, b.droite].filter((l): l is PlanBlock[] => l !== undefined);
    if (CONTAINERS.includes(b.composant) || children.length > 0) {
      if (level >= PAGE_DEPTH) too = true;
    }
    for (const list of children) {
      const m = measure(list, level + 1);
      total += m.total;
      too ||= m.trop;
    }
  }
  return { total, trop: too };
}

export const PlanPage = z
  .object({ blocs: z.array(PlanBlockSchema).min(1) })
  .superRefine((plan, ctx) => {
    const { total, trop: too } = measure(plan.blocs, 0);
    if (total > MAX_PAGE_BLOCKS) ctx.addIssue({ code: "custom", message: `plus de ${MAX_PAGE_BLOCKS} blocs` });
    if (too) ctx.addIssue({ code: "custom", message: `blocs imbriqués sur plus de ${PAGE_DEPTH} niveaux` });
  });
