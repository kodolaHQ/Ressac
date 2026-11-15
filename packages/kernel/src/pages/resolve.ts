import { localUrl } from "../workflows/access.js";
import { emptyResults } from "./preview.js";
import type { ComponentDefinition } from "./catalog.js";
import { MAX_PAGE_BLOCKS, PAGE_DEPTH, evaluate, readPath, readReference, type PlanBlock, type Group, type PlanPage } from "./plan.js";

// The resolution of a plan (validated, or re-read from a run) into a rendered page: references computed, fields read, texts
// bounded. The leak rules (spec 3.7) are here: a link only has an address if it appears as is in the
// results, in http(s), not a local address; an image only in https, and never for an action with an account.
// Never throws: a block that does not resolve becomes an error box, the rest of the page is displayed.

export const ELEMENTS_MAX = 200;
export const TEXT_MAX = 2000;
export const NO_RESULT = "Aucun résultat";
export const FALLBACK_MENTION = "mise en page simple";
export const COMPONENT_UNAVAILABLE = (name: string) => `Composant indisponible : ${name}`;
export const UNREADABLE_BLOCK = (name: string) => `Bloc illisible : ${name}`;
const URL_MAX = 4096;
const CARD_LABELS_MAX = 20;
/** Bounds of the value of a reference given to an agent component. */
const AGENT_DEPTH = 30;
const AGENT_NODES_MAX = 5000;

export type { Group };
/** `url` null : lien inerte (texte seul). */
export type Link = { text: string; url: string | null };
export type Image = { url: string } | { neutral: true } | null;
export type RenderedBlock =
  | { component: string; props: Record<string, unknown>; blocks?: RenderedBlock[]; left?: RenderedBlock[]; right?: RenderedBlock[] }
  | { component: "error"; message: string };
export type RenderedPage = { blocks: RenderedBlock[]; fallback: boolean; empty: boolean; cuts: number };

class Unreadable extends Error {}

const FORMAT = new Intl.NumberFormat("fr-FR");
const primitive = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function cut(s: string, max = TEXT_MAX): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--; // do not cut a surrogate pair
  return s.slice(0, end) + "…";
}

/** A value of the results as text: numbers in fr-FR, lists of plain values joined, empty objects. */
function text(v: unknown): string {
  if (typeof v === "string") return cut(v);
  if (typeof v === "number") return Number.isFinite(v) ? FORMAT.format(v) : "";
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (Array.isArray(v)) return cut(v.slice(0, ELEMENTS_MAX).filter(primitive).map(text).filter(Boolean).join(", "));
  return "";
}

/** Like `text`, but an object or a list of objects is shown as compact JSON, bounded. */
function compactText(v: unknown): string {
  if (v === null || primitive(v) || (Array.isArray(v) && v.every(primitive))) return text(v);
  try {
    return cut(JSON.stringify(v) ?? "");
  } catch {
    return "";
  }
}

/** All the strings of the results (the values, not the keys), at any depth. */
export function chainsOf(results: unknown): Set<string> {
  const chains = new Set<string>();
  const stack: unknown[] = [results];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") chains.add(v);
    else if (Array.isArray(v)) for (const e of v) stack.push(e);
    else if (v !== null && typeof v === "object") for (const k of Object.keys(v)) stack.push((v as Record<string, unknown>)[k]);
  }
  return chains;
}

/** Sets an own property (a « __proto__ » key stays data, never a prototype). */
function ask(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

type Context = {
  results: unknown; account: boolean; defs: Map<string, ComponentDefinition>; cuts: number; blocks: number;
  chains: Set<string> | null; allowed?: ReadonlySet<string>;
};

const chains = (ctx: Context) => (ctx.chains ??= chainsOf(ctx.results));

function urlAllowed(v: unknown, ctx: Context, httpsOnly: boolean): string | null {
  if (typeof v !== "string" || v.length > URL_MAX || !(ctx.allowed ?? chains(ctx)).has(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && (httpsOnly || u.protocol !== "http:")) return null;
  if (u.username || u.password || localUrl(u.hostname)) return null;
  return v;
}

function linkOf(v: unknown, label: string, ctx: Context): Link {
  return { text: label || text(v), url: urlAllowed(v, ctx, false) };
}

function imageOf(v: unknown, ctx: Context): Image {
  if (typeof v !== "string" || v === "") return null;
  if (ctx.account) return { neutral: true };
  const url = urlAllowed(v, ctx, true);
  return url === null ? null : { url };
}

// ---- Defensive reading of a plan's properties ----

function valueFor(ref: unknown, ctx: Context): { value: unknown; grouped: boolean } {
  if (typeof ref !== "string") throw new Unreadable();
  const r = readReference(ref);
  if ("error" in r) throw new Unreadable();
  const v = evaluate(r, ctx.results);
  if ("error" in v) throw new Unreadable();
  return { value: v.value, grouped: r.ops.at(-1)?.op === "group" };
}

function fieldOf(v: unknown): string {
  if (typeof v !== "string") throw new Unreadable();
  const r = readReference(v);
  if ("error" in r || r.ops.length > 0 || r.path === "$") throw new Unreadable();
  return r.path;
}

const a = (props: Record<string, unknown>, k: string) => Object.hasOwn(props, k) && props[k] !== undefined && props[k] !== null;
const optField = (props: Record<string, unknown>, k: string) => (a(props, k) ? fieldOf(props[k]) : null);

function literal(props: Record<string, unknown>, k: string, required: true): string;
function literal(props: Record<string, unknown>, k: string, required?: false): string | null;
function literal(props: Record<string, unknown>, k: string, required = false): string | null {
  if (!a(props, k)) {
    if (required) throw new Unreadable();
    return null;
  }
  if (typeof props[k] !== "string") throw new Unreadable();
  return cut(props[k] as string);
}

function objectOf(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Unreadable();
  return v as Record<string, unknown>;
}

/** A collection cut to `ELEMENTS_MAX` items in all (sections included); the rest is counted. */
function collection<T>(loaded: { value: unknown; grouped: boolean }, ctx: Context, make: (e: unknown) => T) {
  if (!Array.isArray(loaded.value)) throw new Unreadable();
  if (!loaded.grouped) {
    const others = Math.max(0, loaded.value.length - ELEMENTS_MAX);
    ctx.cuts += others;
    return { items: loaded.value.slice(0, ELEMENTS_MAX).map(make), others: others };
  }
  let rest = ELEMENTS_MAX;
  let others = 0;
  const groups: Group<T>[] = [];
  for (const g of loaded.value as Group<unknown>[]) {
    const elements = Array.isArray(g?.items) ? g.items : [];
    const taken = elements.slice(0, rest);
    others += elements.length - taken.length;
    rest -= taken.length;
    if (taken.length > 0) groups.push({ value: text(g.value), items: taken.map(make) });
  }
  ctx.cuts += others;
  return { groups: groups, others: others };
}

function labelsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.slice(0, CARD_LABELS_MAX).filter(primitive).map(text).filter(Boolean);
  const t = text(v);
  return t ? [t] : [];
}

function columnsOf(v: unknown): { field: string; label: string }[] {
  if (!Array.isArray(v)) throw new Unreadable();
  return v.map((c) => {
    const o = objectOf(c);
    const field = fieldOf(o.field);
    return { field: field, label: typeof o.label === "string" ? cut(o.label) : field };
  });
}

function textsOf(loaded: unknown[], ctx: Context, read: (e: unknown) => unknown) {
  const others = Math.max(0, loaded.length - ELEMENTS_MAX);
  ctx.cuts += others;
  return { values: loaded.slice(0, ELEMENTS_MAX).map((e) => text(read(e))).filter(Boolean), others: others };
}

function builtIn(name: string, p: Record<string, unknown>, ctx: Context): Record<string, unknown> {
  switch (name) {
    case "title":
      return { text: literal(p, "text", true) };
    case "paragraph":
      return { text: a(p, "value") ? compactText(valueFor(p.value, ctx).value) : literal(p, "text", true) };
    case "callout": {
      let items: string[] | null = null;
      let others = 0;
      if (a(p, "items")) {
        const l = valueFor(p.items, ctx).value;
        if (!Array.isArray(l)) throw new Unreadable();
        const field = fieldOf(p.field);
        ({ values: items, others } = textsOf(l, ctx, (e) => readPath(e, field)));
      }
      const level = literal(p, "level", true);
      if (!["info", "notice", "warning"].includes(level)) throw new Unreadable();
      return { level: level, title: literal(p, "title"), text: literal(p, "text"), items: items, others: others };
    }
    case "figure":
      return { value: text(valueFor(p.value, ctx).value), label: literal(p, "label", true) };
    case "figures": {
      if (!Array.isArray(p.figures)) throw new Unreadable();
      return {
        figures: p.figures.slice(0, 6).map((c) => {
          const o = objectOf(c);
          return { value: text(valueFor(o.value, ctx).value), label: literal(o, "label", true) };
        }),
      };
    }
    case "list": {
      const title = fieldOf(p.title), subtitle = optField(p, "subtitle"), link = optField(p, "link");
      return collection(valueFor(p.items, ctx), ctx, (e) => {
        const t = text(readPath(e, title));
        return {
          title: t,
          subtitle: subtitle === null ? null : text(readPath(e, subtitle)),
          link: link === null ? null : linkOf(readPath(e, link), t, ctx),
        };
      });
    }
    case "cards": {
      const title = fieldOf(p.title);
      const [subtitle, image, value, labels, link, warnings] = ["subtitle", "image", "value", "tags", "link", "warnings"].map((k) => optField(p, k));
      const read = (e: unknown, c: string | null | undefined) => (c ? readPath(e, c) : undefined);
      return collection(valueFor(p.items, ctx), ctx, (e) => {
        const t = text(readPath(e, title));
        return {
          title: t,
          subtitle: subtitle ? text(read(e, subtitle)) : null,
          image: image ? imageOf(read(e, image), ctx) : null,
          value: value ? text(read(e, value)) : null,
          tags: labels ? labelsOf(read(e, labels)) : [],
          warnings: warnings ? labelsOf(read(e, warnings)) : [],
          link: link ? linkOf(read(e, link), t, ctx) : null,
        };
      });
    }
    case "highlight": {
      const o = objectOf(valueFor(p.object, ctx).value);
      const [subtitle, image, value, body, link] = ["subtitle", "image", "value", "text", "link"].map((k) => optField(p, k));
      const title = text(readPath(o, fieldOf(p.title)));
      const read = (c: string | null | undefined) => (c ? text(readPath(o, c)) : null);
      return {
        label: literal(p, "label"), title: title, subtitle: read(subtitle), image: image ? imageOf(readPath(o, image), ctx) : null,
        value: read(value), text: read(body), link: link ? linkOf(readPath(o, link), title, ctx) : null,
      };
    }
    case "table": {
      const columns = columnsOf(p.columns).slice(0, 8);
      const link = optField(p, "link");
      const r = collection(valueFor(p.items, ctx), ctx, (e) => {
        const values: Record<string, string> = {};
        for (const c of columns) ask(values, c.field, text(readPath(e, c.field)));
        return { values: values, link: link === null ? null : linkOf(readPath(e, link), "", ctx) };
      });
      return { columns: columns, ...r };
    }
    case "fields": {
      const object = objectOf(valueFor(p.object, ctx).value);
      const fieldList = a(p, "fields")
        ? columnsOf(p.fields).slice(0, 12).map((c) => ({ label: c.label, value: text(readPath(object, c.field)) }))
        : Object.keys(object).filter((k) => primitive(object[k])).map((k) => ({ label: cut(k), value: text(object[k]) }));
      const others = Math.max(0, fieldList.length - ELEMENTS_MAX);
      ctx.cuts += others;
      return { fields: fieldList.slice(0, ELEMENTS_MAX), others: others };
    }
    case "tags": {
      if (a(p, "values")) {
        const l = valueFor(p.values, ctx).value;
        if (!Array.isArray(l)) throw new Unreadable();
        return textsOf(l.filter(primitive), ctx, (e) => e);
      }
      const l = valueFor(p.items, ctx).value;
      if (!Array.isArray(l)) throw new Unreadable();
      const field = fieldOf(p.field);
      return textsOf(l, ctx, (e) => readPath(e, field));
    }
    case "link": {
      const object = objectOf(valueFor(p.object, ctx).value);
      const url = readPath(object, fieldOf(p.url));
      const label = a(p, "textField") ? text(readPath(object, fieldOf(p.textField))) : (literal(p, "text") ?? "");
      return { link: linkOf(url, label, ctx) };
    }
    case "group":
      return { title: literal(p, "title", true), collapsed: p.collapsed === true };
    case "columns":
      return {};
    default:
      throw new Unreadable();
  }
}

/** The value of a reference for an agent component: own properties, lists at 200, texts cut, size bounded. */
function clamp(v: unknown, ctx: Context, budget: { nodes: number }, prof = 0): unknown {
  if (--budget.nodes < 0) return null;
  if (typeof v === "string") return cut(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null) return v;
  if (typeof v !== "object" || prof >= AGENT_DEPTH) return null;
  if (Array.isArray(v)) {
    if (v.length > ELEMENTS_MAX) ctx.cuts += v.length - ELEMENTS_MAX;
    return v.slice(0, ELEMENTS_MAX).map((e) => clamp(e, ctx, budget, prof + 1));
  }
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(v).slice(0, ELEMENTS_MAX)) ask(o, k, clamp((v as Record<string, unknown>)[k], ctx, budget, prof + 1));
  return o;
}

function agent(def: ComponentDefinition, p: Record<string, unknown>, ctx: Context): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, pr] of Object.entries(def.properties)) {
    if (!a(p, name)) {
      if (pr.required) throw new Unreadable();
      continue;
    }
    const v = p[name];
    switch (pr.kind) {
      case "reference": props[name] = clamp(valueFor(v, ctx).value, ctx, { nodes: AGENT_NODES_MAX }); break;
      case "field": props[name] = fieldOf(v); break;
      case "text": props[name] = literal(p, name); break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Unreadable();
        props[name] = v;
        break;
      case "checkbox":
        if (typeof v !== "boolean") throw new Unreadable();
        props[name] = v;
        break;
      default: throw new Unreadable();
    }
  }
  return props;
}

function resolveBlocks(blocks: unknown, level: number, ctx: Context): RenderedBlock[] {
  if (!Array.isArray(blocks)) return [];
  const renders: RenderedBlock[] = [];
  for (const b of blocks as PlanBlock[]) {
    if (++ctx.blocks > MAX_PAGE_BLOCKS) break;
    if (b === null || typeof b !== "object") continue;
    const name = typeof b.component === "string" ? b.component.slice(0, 40) : "?";
    const def = ctx.defs.get(name);
    if (!def) {
      renders.push({ component: "error", message: COMPONENT_UNAVAILABLE(name) });
      continue;
    }
    try {
      const p = b.props !== null && typeof b.props === "object" ? b.props : {};
      const rendered: RenderedBlock = { component: name, props: def.origin === "agent" ? agent(def, p, ctx) : builtIn(name, p, ctx) };
      if (def.origin === "builtin" && level < PAGE_DEPTH) {
        if (name === "group") rendered.blocks = resolveBlocks(b.blocks, level + 1, ctx);
        if (name === "columns") {
          rendered.left = resolveBlocks(b.left, level + 1, ctx);
          rendered.right = resolveBlocks(b.right, level + 1, ctx);
        }
      }
      renders.push(rendered);
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      renders.push({ component: "error", message: UNREADABLE_BLOCK(name) });
    }
  }
  return renders;
}

export function resolvePage(
  plan: PlanPage,
  results: unknown,
  o: { account: boolean; catalog: ComponentDefinition[]; fallback: boolean; allowed?: ReadonlySet<string> },
): RenderedPage {
  const ctx: Context = { results: results, account: o.account, defs: new Map(o.catalog.map((d) => [d.name, d])), cuts: 0, blocks: 0, chains: null, allowed: o.allowed };
  const blocks = resolveBlocks(plan?.blocks, 0, ctx);
  return { blocks: blocks, fallback: o.fallback, empty: emptyResults(results), cuts: ctx.cuts };
}
