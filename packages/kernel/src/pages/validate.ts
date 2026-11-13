import type { ComponentDefinition, Property } from "./catalog.js";
import { PlanPage, evaluate, readReference, readPath, type PlanBlock, type Group } from "./plan.js";

// The validation of Gemma's plan, which is hostile data (it may have read a booby-trapped page). Nothing throws: an
// unreadable plan returns `ok: false`. The reasons are written by Ressac and never quote a value of the results (only
// names of properties, fields and paths, written by the plan itself).

export const PLAN_REFERENCES_NOTHING = "le plan ne référence rien";
/** Bounds of the raw JSON, checked before zod (which overflows the stack on a plan nested thousands of levels deep). */
const RAW_DEPTH_MAX = 64;
const RAW_NODES_MAX = 50_000;
const MAX_ERRORS = 10;
const MAX_ERROR = 200;
const LABEL_MAX = 60;
const AGENT_TEXT_MAX = 400;

export type ValidationResult = { ok: true; plan: PlanPage; discarded: string[] } | { ok: false; errors: string[] };

class Gap extends Error {}

/** Expected kind of a reference's value, per built-in component and property. */
const EXPECTED: Record<string, "list" | "object" | "simple"> = {
  "paragraph.value": "simple", "figure.value": "simple", "callout.items": "list",
  "list.items": "list", "cards.items": "list", "table.items": "list",
  "fields.object": "object", "highlight.object": "object", "tags.values": "list", "tags.items": "list", "link.object": "object",
};
/** The property that carries the items where its fields are read. */
const SOURCE: Record<string, string> = {
  callout: "items", list: "items", cards: "items", table: "items", highlight: "object", tags: "items", link: "object", fields: "object",
};
const CHILDREN: Record<string, ("blocks" | "left" | "right")[]> = { group: ["blocks"], columns: ["left", "right"] };

function cut(s: string): string {
  return s.length > MAX_ERROR ? s.slice(0, MAX_ERROR - 1) + "…" : s;
}

/** A raw JSON small and shallow enough to be read without risk; otherwise the reason. Iterative. */
function precheck(raw: unknown): string | null {
  const stack: [unknown, number][] = [[raw, 0]];
  let nodes = 0;
  while (stack.length > 0) {
    const [v, prof] = stack.pop()!;
    if (++nodes > RAW_NODES_MAX) return "plan trop gros";
    if (v === null || typeof v !== "object") continue;
    if (prof >= RAW_DEPTH_MAX) return "plan imbriqué trop profondément";
    if (Array.isArray(v)) {
      if (v.length > RAW_NODES_MAX) return "plan trop gros";
      for (const e of v) stack.push([e, prof + 1]);
    } else {
      for (const k of Object.keys(v)) stack.push([(v as Record<string, unknown>)[k], prof + 1]);
    }
  }
  return null;
}

const primitive = (v: unknown) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const present = (props: Record<string, unknown>, name: string) => Object.hasOwn(props, name) && props[name] !== undefined && props[name] !== null;

/** A reference read and computed; its value checked according to `attendu`. */
function checkReference(text: unknown, expected: "list" | "object" | "simple" | undefined, results: unknown) {
  if (typeof text !== "string") throw new Gap("référence attendue (un texte)");
  const ref = readReference(text);
  if ("error" in ref) throw new Gap(ref.error);
  const r = evaluate(ref, results);
  if ("error" in r) throw new Gap(r.error);
  const v = r.value;
  if (expected === "list" && !Array.isArray(v)) throw new Gap("liste attendue");
  if (expected === "object" && (v === null || typeof v !== "object" || Array.isArray(v))) throw new Gap("objet attendu");
  if (expected === "simple" && !primitive(v)) throw new Gap("valeur simple attendue");
  return { text: text, value: v, grouped: ref.ops.at(-1)?.op === "group" };
}

/** A field: a path relative to an item, never a reference nor a free text (an address written by Gemma fails here). */
function readField(text: unknown): string {
  if (typeof text !== "string") throw new Gap("nom de champ attendu");
  const ref = readReference(text);
  if ("error" in ref) throw new Gap(ref.error);
  if (ref.ops.length > 0) throw new Gap("un nom de champ est attendu, pas une référence");
  if (ref.path === "$") throw new Gap("nom de champ attendu");
  return ref.path;
}

function checkText(v: unknown, max: number): string {
  if (typeof v !== "string") throw new Gap("texte attendu");
  if (v.length > max) throw new Gap(`trop long (plus de ${max} caractères)`);
  return v;
}

function checkList(v: unknown, max: number, forme: string): unknown[] {
  if (!Array.isArray(v) || v.length === 0) throw new Gap(`liste de ${forme} attendue`);
  if (v.length > max) throw new Gap(`${max} au plus`);
  return v;
}

function objectOf(v: unknown, forme: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Gap(`liste de ${forme} attendue`);
  return v as Record<string, unknown>;
}

type Checked = { props: Record<string, unknown>; reference: boolean };

function checkProps(def: ComponentDefinition, raw: Record<string, unknown>, results: unknown): Checked {
  const props: Record<string, unknown> = {};
  const values: Record<string, { value: unknown; grouped: boolean }> = {};
  const fieldsToCheck: { name: string; field: string }[] = [];
  let reference = false;
  const builtIn = def.origin === "builtin";

  for (const [name, pr] of Object.entries(def.properties) as [string, Property][]) {
    if (!present(raw, name)) {
      if (pr.required) throw new Gap(`${name} : requise`);
      continue;
    }
    const v = raw[name];
    try {
      switch (pr.kind) {
        case "reference": {
          // « $ » given to a paragraph: all the results as compact text, the last-resort layout.
          const expected = builtIn && !(def.name === "paragraph" && v === "$") ? EXPECTED[`${def.name}.${name}`] : undefined;
          const r = checkReference(v, expected, results);
          props[name] = r.text;
          values[name] = r;
          reference = true;
          break;
        }
        case "field":
          props[name] = readField(v);
          fieldsToCheck.push({ name: name, field: props[name] as string });
          break;
        case "text":
          props[name] = checkText(v, pr.max ?? AGENT_TEXT_MAX);
          break;
        case "number":
          if (typeof v !== "number" || !Number.isFinite(v)) throw new Gap("nombre attendu");
          props[name] = v;
          break;
        case "checkbox":
          if (typeof v !== "boolean") throw new Gap("vrai ou faux attendu");
          props[name] = v;
          break;
        case "choice": {
          const choice = pr.choices ?? [];
          if (typeof v !== "string" || !choice.includes(v)) {
            throw new Gap(`${choice.slice(0, -1).join(", ")}${choice.length > 1 ? " ou " : ""}${choice.at(-1) ?? ""} attendu`);
          }
          props[name] = v;
          break;
        }
        case "columns": {
          const forme = "{ field, label }";
          props[name] = checkList(v, pr.max ?? 8, forme).map((e) => {
            const o = objectOf(e, forme);
            const field = readField(o.field);
            const label = present(o, "label") ? checkText(o.label, LABEL_MAX) : field;
            fieldsToCheck.push({ name: name, field: field });
            return { field: field, label: label };
          });
          break;
        }
        case "figures": {
          const forme = "{ value, label }";
          props[name] = checkList(v, pr.max ?? 6, forme).map((e) => {
            const o = objectOf(e, forme);
            if (!present(o, "value")) throw new Gap("value requise");
            if (!present(o, "label")) throw new Gap("label requis");
            const value = checkReference(o.value, "simple", results).text;
            return { value: value, label: checkText(o.label, LABEL_MAX) };
          });
          reference = true;
          break;
        }
      }
    } catch (e) {
      if (e instanceof Gap) throw new Gap(`${name} : ${e.message}`);
      throw e;
    }
  }

  if (builtIn) applyRules(def.name, props);

  // A field must exist in at least one item of the referenced list (an empty list says nothing).
  const source = builtIn ? SOURCE[def.name] : undefined;
  const loaded = source !== undefined && Object.hasOwn(props, source) ? values[source] : undefined;
  if (loaded) {
    const elements = elementsOf(loaded);
    for (const { name: name, field: field } of fieldsToCheck) {
      if (!Object.hasOwn(props, name)) continue;
      if (elements.length > 0 && !elements.some((e) => readPath(e, field) !== undefined)) {
        throw new Gap(`${name} : champ « ${field} » absent de tous les éléments`);
      }
    }
  }
  return { props, reference };
}

function elementsOf(loaded: { value: unknown; grouped: boolean }): unknown[] {
  if (!Array.isArray(loaded.value)) return [loaded.value];
  if (!loaded.grouped) return loaded.value;
  return (loaded.value as Group<unknown>[]).flatMap((g) => g.items);
}

/** The catalog's « one or the other » rules. */
function applyRules(name: string, props: Record<string, unknown>): void {
  const a = (k: string) => Object.hasOwn(props, k);
  switch (name) {
    case "paragraph":
      if (!a("text") && !a("value")) throw new Gap("text ou value attendu");
      if (a("value")) delete props.text;
      break;
    case "tags":
      if (a("values")) { delete props.items; delete props.field; break; }
      if (!a("items") || !a("field")) throw new Gap("values, ou items avec field, attendu");
      break;
    case "callout":
      if (a("items") !== a("field")) throw new Gap("items et field vont ensemble");
      break;
    case "link":
      if (a("textField")) delete props.text;
      break;
  }
}

function countBlocks(b: PlanBlock): number {
  let n = 0;
  for (const l of [b.blocks, b.left, b.right]) for (const e of l ?? []) n += 1 + countBlocks(e);
  return n;
}

type Context = { defs: Map<string, ComponentDefinition>; results: unknown; discarded: string[]; n: number; references: number; highlight: boolean };

function validateBlocks(blocks: PlanBlock[], ctx: Context): PlanBlock[] {
  const guards: PlanBlock[] = [];
  for (const b of blocks) {
    const n = ++ctx.n;
    const def = ctx.defs.get(b.component);
    if (!def) {
      // Unknown: kept (drawn as an error box), its children will not be drawn.
      ctx.n += countBlocks(b);
      guards.push({ component: b.component, props: Object.fromEntries(Object.entries(b.props)) });
      continue;
    }
    let v: Checked;
    try {
      v = checkProps(def, b.props, ctx.results);
    } catch (e) {
      if (!(e instanceof Gap)) throw e;
      ctx.discarded.push(cut(`${n}. ${b.component} : ${e.message}`));
      ctx.n += countBlocks(b);
      continue;
    }
    if (def.origin === "builtin" && def.name === "highlight") {
      if (ctx.highlight) {
        ctx.discarded.push(cut(`${n}. highlight : une seule par page`));
        continue;
      }
      ctx.highlight = true;
    }
    if (v.reference) ctx.references++;
    const kept: PlanBlock = { component: b.component, props: v.props };
    const children = def.origin === "builtin" ? (CHILDREN[def.name] ?? []) : [];
    for (const key of ["blocks", "left", "right"] as const) {
      const list = b[key];
      if (list === undefined) continue;
      if (children.includes(key)) kept[key] = validateBlocks(list, ctx);
      else ctx.n += list.reduce((s, e) => s + 1 + countBlocks(e), 0);
    }
    guards.push(kept);
  }
  return guards;
}

export function validatePlan(raw: unknown, o: { catalog: ComponentDefinition[]; results: unknown }): ValidationResult {
  try {
    const too = precheck(raw);
    if (too) return { ok: false, errors: [too] };
    const r = PlanPage.safeParse(raw);
    if (!r.success) {
      return {
        ok: false,
        errors: r.error.issues.slice(0, MAX_ERRORS).map((i) => cut(i.path.length ? `${i.path.join(".")} : ${i.message}` : i.message)),
      };
    }
    const ctx: Context = { defs: new Map(o.catalog.map((d) => [d.name, d])), results: o.results, discarded: [], n: 0, references: 0, highlight: false };
    const blocks = validateBlocks(r.data.blocks, ctx);
    if (ctx.references === 0) return { ok: false, errors: [PLAN_REFERENCES_NOTHING, ...ctx.discarded] };
    return { ok: true, plan: { blocks: blocks }, discarded: ctx.discarded };
  } catch {
    return { ok: false, errors: ["plan illisible"] };
  }
}
