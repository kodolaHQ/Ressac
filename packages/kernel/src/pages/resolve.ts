import { localUrl } from "../workflows/access.js";
import { emptyResults } from "./preview.js";
import type { ComponentDefinition } from "./catalogue.js";
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
export type Link = { texte: string; url: string | null };
export type Image = { url: string } | { neutre: true } | null;
export type RenderedBlock =
  | { composant: string; props: Record<string, unknown>; blocs?: RenderedBlock[]; gauche?: RenderedBlock[]; droite?: RenderedBlock[] }
  | { composant: "erreur"; message: string };
export type RenderedPage = { blocs: RenderedBlock[]; secours: boolean; vide: boolean; coupes: number };

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

/** Like `texte`, but an object or a list of objects is shown as compact JSON, bounded. */
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
  resultats: unknown; compte: boolean; defs: Map<string, ComponentDefinition>; coupes: number; blocs: number;
  chaines: Set<string> | null;
};

const chains = (ctx: Context) => (ctx.chaines ??= chainsOf(ctx.resultats));

function urlAllowed(v: unknown, ctx: Context, httpsOnly: boolean): string | null {
  if (typeof v !== "string" || v.length > URL_MAX || !chains(ctx).has(v)) return null;
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
  return { texte: label || text(v), url: urlAllowed(v, ctx, false) };
}

function imageOf(v: unknown, ctx: Context): Image {
  if (typeof v !== "string" || v === "") return null;
  if (ctx.compte) return { neutre: true };
  const url = urlAllowed(v, ctx, true);
  return url === null ? null : { url };
}

// ---- Defensive reading of a plan's properties ----

function valueFor(ref: unknown, ctx: Context): { valeur: unknown; groupee: boolean } {
  if (typeof ref !== "string") throw new Unreadable();
  const r = readReference(ref);
  if ("erreur" in r) throw new Unreadable();
  const v = evaluate(r, ctx.resultats);
  if ("erreur" in v) throw new Unreadable();
  return { valeur: v.valeur, groupee: r.ops.at(-1)?.op === "regrouper" };
}

function fieldOf(v: unknown): string {
  if (typeof v !== "string") throw new Unreadable();
  const r = readReference(v);
  if ("erreur" in r || r.ops.length > 0 || r.chemin === "$") throw new Unreadable();
  return r.chemin;
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
function collection<T>(loaded: { valeur: unknown; groupee: boolean }, ctx: Context, make: (e: unknown) => T) {
  if (!Array.isArray(loaded.valeur)) throw new Unreadable();
  if (!loaded.groupee) {
    const others = Math.max(0, loaded.valeur.length - ELEMENTS_MAX);
    ctx.coupes += others;
    return { elements: loaded.valeur.slice(0, ELEMENTS_MAX).map(make), autres: others };
  }
  let rest = ELEMENTS_MAX;
  let others = 0;
  const groups: Group<T>[] = [];
  for (const g of loaded.valeur as Group<unknown>[]) {
    const elements = Array.isArray(g?.elements) ? g.elements : [];
    const taken = elements.slice(0, rest);
    others += elements.length - taken.length;
    rest -= taken.length;
    if (taken.length > 0) groups.push({ valeur: text(g.valeur), elements: taken.map(make) });
  }
  ctx.coupes += others;
  return { groupes: groups, autres: others };
}

function labelsOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.slice(0, CARD_LABELS_MAX).filter(primitive).map(text).filter(Boolean);
  const t = text(v);
  return t ? [t] : [];
}

function columnsOf(v: unknown): { champ: string; libelle: string }[] {
  if (!Array.isArray(v)) throw new Unreadable();
  return v.map((c) => {
    const o = objectOf(c);
    const field = fieldOf(o.champ);
    return { champ: field, libelle: typeof o.libelle === "string" ? cut(o.libelle) : field };
  });
}

function textsOf(loaded: unknown[], ctx: Context, read: (e: unknown) => unknown) {
  const others = Math.max(0, loaded.length - ELEMENTS_MAX);
  ctx.coupes += others;
  return { valeurs: loaded.slice(0, ELEMENTS_MAX).map((e) => text(read(e))).filter(Boolean), autres: others };
}

function builtIn(name: string, p: Record<string, unknown>, ctx: Context): Record<string, unknown> {
  switch (name) {
    case "titre":
      return { texte: literal(p, "texte", true) };
    case "paragraphe":
      return { texte: a(p, "valeur") ? compactText(valueFor(p.valeur, ctx).valeur) : literal(p, "texte", true) };
    case "encadre": {
      let elements: string[] | null = null;
      let others = 0;
      if (a(p, "elements")) {
        const l = valueFor(p.elements, ctx).valeur;
        if (!Array.isArray(l)) throw new Unreadable();
        const field = fieldOf(p.champ);
        ({ valeurs: elements, autres: others } = textsOf(l, ctx, (e) => readPath(e, field)));
      }
      const level = literal(p, "niveau", true);
      if (!["info", "avis", "attention"].includes(level)) throw new Unreadable();
      return { niveau: level, titre: literal(p, "titre"), texte: literal(p, "texte"), elements, autres: others };
    }
    case "chiffre":
      return { valeur: text(valueFor(p.valeur, ctx).valeur), libelle: literal(p, "libelle", true) };
    case "chiffres": {
      if (!Array.isArray(p.chiffres)) throw new Unreadable();
      return {
        chiffres: p.chiffres.slice(0, 6).map((c) => {
          const o = objectOf(c);
          return { valeur: text(valueFor(o.valeur, ctx).valeur), libelle: literal(o, "libelle", true) };
        }),
      };
    }
    case "liste": {
      const title = fieldOf(p.titre), subtitle = optField(p, "sousTitre"), link = optField(p, "lien");
      return collection(valueFor(p.elements, ctx), ctx, (e) => {
        const t = text(readPath(e, title));
        return {
          titre: t,
          sousTitre: subtitle === null ? null : text(readPath(e, subtitle)),
          lien: link === null ? null : linkOf(readPath(e, link), t, ctx),
        };
      });
    }
    case "cartes": {
      const title = fieldOf(p.titre);
      const [subtitle, image, value, labels, link] = ["sousTitre", "image", "valeur", "etiquettes", "lien"].map((k) => optField(p, k));
      const read = (e: unknown, c: string | null | undefined) => (c ? readPath(e, c) : undefined);
      return collection(valueFor(p.elements, ctx), ctx, (e) => {
        const t = text(readPath(e, title));
        return {
          titre: t,
          sousTitre: subtitle ? text(read(e, subtitle)) : null,
          image: image ? imageOf(read(e, image), ctx) : null,
          valeur: value ? text(read(e, value)) : null,
          etiquettes: labels ? labelsOf(read(e, labels)) : [],
          lien: link ? linkOf(read(e, link), t, ctx) : null,
        };
      });
    }
    case "tableau": {
      const columns = columnsOf(p.colonnes).slice(0, 8);
      const link = optField(p, "lien");
      const r = collection(valueFor(p.elements, ctx), ctx, (e) => {
        const values: Record<string, string> = {};
        for (const c of columns) ask(values, c.champ, text(readPath(e, c.champ)));
        return { valeurs: values, lien: link === null ? null : linkOf(readPath(e, link), "", ctx) };
      });
      return { colonnes: columns, ...r };
    }
    case "champs": {
      const object = objectOf(valueFor(p.objet, ctx).valeur);
      const champs = a(p, "champs")
        ? columnsOf(p.champs).slice(0, 12).map((c) => ({ libelle: c.libelle, valeur: text(readPath(object, c.champ)) }))
        : Object.keys(object).filter((k) => primitive(object[k])).map((k) => ({ libelle: cut(k), valeur: text(object[k]) }));
      const others = Math.max(0, champs.length - ELEMENTS_MAX);
      ctx.coupes += others;
      return { champs: champs.slice(0, ELEMENTS_MAX), autres: others };
    }
    case "etiquettes": {
      if (a(p, "valeurs")) {
        const l = valueFor(p.valeurs, ctx).valeur;
        if (!Array.isArray(l)) throw new Unreadable();
        return textsOf(l.filter(primitive), ctx, (e) => e);
      }
      const l = valueFor(p.elements, ctx).valeur;
      if (!Array.isArray(l)) throw new Unreadable();
      const field = fieldOf(p.champ);
      return textsOf(l, ctx, (e) => readPath(e, field));
    }
    case "lien": {
      const object = objectOf(valueFor(p.objet, ctx).valeur);
      const url = readPath(object, fieldOf(p.url));
      const label = a(p, "champTexte") ? text(readPath(object, fieldOf(p.champTexte))) : (literal(p, "texte") ?? "");
      return { lien: linkOf(url, label, ctx) };
    }
    case "groupe":
      return { titre: literal(p, "titre", true), replie: p.replie === true };
    case "colonnes":
      return {};
    default:
      throw new Unreadable();
  }
}

/** The value of a reference for an agent component: own properties, lists at 200, texts cut, size bounded. */
function clamp(v: unknown, ctx: Context, budget: { noeuds: number }, prof = 0): unknown {
  if (--budget.noeuds < 0) return null;
  if (typeof v === "string") return cut(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null) return v;
  if (typeof v !== "object" || prof >= AGENT_DEPTH) return null;
  if (Array.isArray(v)) {
    if (v.length > ELEMENTS_MAX) ctx.coupes += v.length - ELEMENTS_MAX;
    return v.slice(0, ELEMENTS_MAX).map((e) => clamp(e, ctx, budget, prof + 1));
  }
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(v).slice(0, ELEMENTS_MAX)) ask(o, k, clamp((v as Record<string, unknown>)[k], ctx, budget, prof + 1));
  return o;
}

function agent(def: ComponentDefinition, p: Record<string, unknown>, ctx: Context): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, pr] of Object.entries(def.proprietes)) {
    if (!a(p, name)) {
      if (pr.requis) throw new Unreadable();
      continue;
    }
    const v = p[name];
    switch (pr.genre) {
      case "reference": props[name] = clamp(valueFor(v, ctx).valeur, ctx, { noeuds: AGENT_NODES_MAX }); break;
      case "champ": props[name] = fieldOf(v); break;
      case "texte": props[name] = literal(p, name); break;
      case "nombre":
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Unreadable();
        props[name] = v;
        break;
      case "case":
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
    if (++ctx.blocs > MAX_PAGE_BLOCKS) break;
    if (b === null || typeof b !== "object") continue;
    const name = typeof b.composant === "string" ? b.composant.slice(0, 40) : "?";
    const def = ctx.defs.get(name);
    if (!def) {
      renders.push({ composant: "erreur", message: COMPONENT_UNAVAILABLE(name) });
      continue;
    }
    try {
      const p = b.props !== null && typeof b.props === "object" ? b.props : {};
      const rendered: RenderedBlock = { composant: name, props: def.origine === "agent" ? agent(def, p, ctx) : builtIn(name, p, ctx) };
      if (def.origine === "integre" && level < PAGE_DEPTH) {
        if (name === "groupe") rendered.blocs = resolveBlocks(b.blocs, level + 1, ctx);
        if (name === "colonnes") {
          rendered.gauche = resolveBlocks(b.gauche, level + 1, ctx);
          rendered.droite = resolveBlocks(b.droite, level + 1, ctx);
        }
      }
      renders.push(rendered);
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      renders.push({ composant: "erreur", message: UNREADABLE_BLOCK(name) });
    }
  }
  return renders;
}

export function resolvePage(
  plan: PlanPage,
  results: unknown,
  o: { compte: boolean; catalogue: ComponentDefinition[]; secours: boolean },
): RenderedPage {
  const ctx: Context = { resultats: results, compte: o.compte, defs: new Map(o.catalogue.map((d) => [d.nom, d])), coupes: 0, blocs: 0, chaines: null };
  const blocks = resolveBlocks(plan?.blocs, 0, ctx);
  return { blocs: blocks, secours: o.secours, vide: emptyResults(results), coupes: ctx.coupes };
}
