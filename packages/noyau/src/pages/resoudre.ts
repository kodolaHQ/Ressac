import { localUrl } from "../workflows/acces.js";
import { emptyResults } from "./apercu.js";
import type { ComponentDefinition } from "./catalogue.js";
import { MAX_BLOCS_PAGE, PAGE_DEPTH, evaluate, readPath, lireReference, type BlocPlan, type Group, type PlanPage } from "./plan.js";

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
const ETIQUETTES_CARTE_MAX = 20;
/** Bounds of the value of a reference given to an agent component. */
const AGENT_DEPTH = 30;
const AGENT_NODES_MAX = 5000;

export type { Group };
/** `url` null : lien inerte (texte seul). */
export type Lien = { texte: string; url: string | null };
export type Image = { url: string } | { neutre: true } | null;
export type RenderedBlock =
  | { composant: string; props: Record<string, unknown>; blocs?: RenderedBlock[]; gauche?: RenderedBlock[]; droite?: RenderedBlock[] }
  | { composant: "erreur"; message: string };
export type RenderedPage = { blocs: RenderedBlock[]; secours: boolean; vide: boolean; coupes: number };

class Unreadable extends Error {}

const FORMAT = new Intl.NumberFormat("fr-FR");
const primitive = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function couper(s: string, max = TEXT_MAX): string {
  if (s.length <= max) return s;
  let fin = max - 1;
  const c = s.charCodeAt(fin - 1);
  if (c >= 0xd800 && c <= 0xdbff) fin--; // do not cut a surrogate pair
  return s.slice(0, fin) + "…";
}

/** A value of the results as text: numbers in fr-FR, lists of plain values joined, empty objects. */
function text(v: unknown): string {
  if (typeof v === "string") return couper(v);
  if (typeof v === "number") return Number.isFinite(v) ? FORMAT.format(v) : "";
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (Array.isArray(v)) return couper(v.slice(0, ELEMENTS_MAX).filter(primitive).map(text).filter(Boolean).join(", "));
  return "";
}

/** Like `texte`, but an object or a list of objects is shown as compact JSON, bounded. */
function compactText(v: unknown): string {
  if (v === null || primitive(v) || (Array.isArray(v) && v.every(primitive))) return text(v);
  try {
    return couper(JSON.stringify(v) ?? "");
  } catch {
    return "";
  }
}

/** All the strings of the results (the values, not the keys), at any depth. */
export function chainsOf(results: unknown): Set<string> {
  const chains = new Set<string>();
  const pile: unknown[] = [results];
  while (pile.length > 0) {
    const v = pile.pop();
    if (typeof v === "string") chains.add(v);
    else if (Array.isArray(v)) for (const e of v) pile.push(e);
    else if (v !== null && typeof v === "object") for (const k of Object.keys(v)) pile.push((v as Record<string, unknown>)[k]);
  }
  return chains;
}

/** Sets an own property (a « __proto__ » key stays data, never a prototype). */
function poser(o: Record<string, unknown>, k: string, v: unknown): void {
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

function lienDe(v: unknown, label: string, ctx: Context): Lien {
  return { texte: label || text(v), url: urlAllowed(v, ctx, false) };
}

function imageDe(v: unknown, ctx: Context): Image {
  if (typeof v !== "string" || v === "") return null;
  if (ctx.compte) return { neutre: true };
  const url = urlAllowed(v, ctx, true);
  return url === null ? null : { url };
}

// ---- Defensive reading of a plan's properties ----

function valeurDe(ref: unknown, ctx: Context): { valeur: unknown; groupee: boolean } {
  if (typeof ref !== "string") throw new Unreadable();
  const r = lireReference(ref);
  if ("erreur" in r) throw new Unreadable();
  const v = evaluate(r, ctx.resultats);
  if ("erreur" in v) throw new Unreadable();
  return { valeur: v.valeur, groupee: r.ops.at(-1)?.op === "regrouper" };
}

function champDe(v: unknown): string {
  if (typeof v !== "string") throw new Unreadable();
  const r = lireReference(v);
  if ("erreur" in r || r.ops.length > 0 || r.chemin === "$") throw new Unreadable();
  return r.chemin;
}

const a = (props: Record<string, unknown>, k: string) => Object.hasOwn(props, k) && props[k] !== undefined && props[k] !== null;
const champOpt = (props: Record<string, unknown>, k: string) => (a(props, k) ? champDe(props[k]) : null);

function literal(props: Record<string, unknown>, k: string, required: true): string;
function literal(props: Record<string, unknown>, k: string, required?: false): string | null;
function literal(props: Record<string, unknown>, k: string, required = false): string | null {
  if (!a(props, k)) {
    if (required) throw new Unreadable();
    return null;
  }
  if (typeof props[k] !== "string") throw new Unreadable();
  return couper(props[k] as string);
}

function objectOf(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Unreadable();
  return v as Record<string, unknown>;
}

/** A collection cut to `ELEMENTS_MAX` items in all (sections included); the rest is counted. */
function collection<T>(lue: { valeur: unknown; groupee: boolean }, ctx: Context, make: (e: unknown) => T) {
  if (!Array.isArray(lue.valeur)) throw new Unreadable();
  if (!lue.groupee) {
    const others = Math.max(0, lue.valeur.length - ELEMENTS_MAX);
    ctx.coupes += others;
    return { elements: lue.valeur.slice(0, ELEMENTS_MAX).map(make), autres: others };
  }
  let rest = ELEMENTS_MAX;
  let others = 0;
  const groups: Group<T>[] = [];
  for (const g of lue.valeur as Group<unknown>[]) {
    const elements = Array.isArray(g?.elements) ? g.elements : [];
    const taken = elements.slice(0, rest);
    others += elements.length - taken.length;
    rest -= taken.length;
    if (taken.length > 0) groups.push({ valeur: text(g.valeur), elements: taken.map(make) });
  }
  ctx.coupes += others;
  return { groupes: groups, autres: others };
}

function etiquettesDe(v: unknown): string[] {
  if (Array.isArray(v)) return v.slice(0, ETIQUETTES_CARTE_MAX).filter(primitive).map(text).filter(Boolean);
  const t = text(v);
  return t ? [t] : [];
}

function columnsOf(v: unknown): { champ: string; libelle: string }[] {
  if (!Array.isArray(v)) throw new Unreadable();
  return v.map((c) => {
    const o = objectOf(c);
    const champ = champDe(o.champ);
    return { champ, libelle: typeof o.libelle === "string" ? couper(o.libelle) : champ };
  });
}

function textsOf(lue: unknown[], ctx: Context, lire: (e: unknown) => unknown) {
  const others = Math.max(0, lue.length - ELEMENTS_MAX);
  ctx.coupes += others;
  return { valeurs: lue.slice(0, ELEMENTS_MAX).map((e) => text(lire(e))).filter(Boolean), autres: others };
}

function builtIn(name: string, p: Record<string, unknown>, ctx: Context): Record<string, unknown> {
  switch (name) {
    case "titre":
      return { texte: literal(p, "texte", true) };
    case "paragraphe":
      return { texte: a(p, "valeur") ? compactText(valeurDe(p.valeur, ctx).valeur) : literal(p, "texte", true) };
    case "encadre": {
      let elements: string[] | null = null;
      let others = 0;
      if (a(p, "elements")) {
        const l = valeurDe(p.elements, ctx).valeur;
        if (!Array.isArray(l)) throw new Unreadable();
        const champ = champDe(p.champ);
        ({ valeurs: elements, autres: others } = textsOf(l, ctx, (e) => readPath(e, champ)));
      }
      const level = literal(p, "niveau", true);
      if (!["info", "avis", "attention"].includes(level)) throw new Unreadable();
      return { niveau: level, titre: literal(p, "titre"), texte: literal(p, "texte"), elements, autres: others };
    }
    case "chiffre":
      return { valeur: text(valeurDe(p.valeur, ctx).valeur), libelle: literal(p, "libelle", true) };
    case "chiffres": {
      if (!Array.isArray(p.chiffres)) throw new Unreadable();
      return {
        chiffres: p.chiffres.slice(0, 6).map((c) => {
          const o = objectOf(c);
          return { valeur: text(valeurDe(o.valeur, ctx).valeur), libelle: literal(o, "libelle", true) };
        }),
      };
    }
    case "liste": {
      const titre = champDe(p.titre), sousTitre = champOpt(p, "sousTitre"), lien = champOpt(p, "lien");
      return collection(valeurDe(p.elements, ctx), ctx, (e) => {
        const t = text(readPath(e, titre));
        return {
          titre: t,
          sousTitre: sousTitre === null ? null : text(readPath(e, sousTitre)),
          lien: lien === null ? null : lienDe(readPath(e, lien), t, ctx),
        };
      });
    }
    case "cartes": {
      const titre = champDe(p.titre);
      const [sousTitre, image, valeur, etiquettes, lien] = ["sousTitre", "image", "valeur", "etiquettes", "lien"].map((k) => champOpt(p, k));
      const lire = (e: unknown, c: string | null | undefined) => (c ? readPath(e, c) : undefined);
      return collection(valeurDe(p.elements, ctx), ctx, (e) => {
        const t = text(readPath(e, titre));
        return {
          titre: t,
          sousTitre: sousTitre ? text(lire(e, sousTitre)) : null,
          image: image ? imageDe(lire(e, image), ctx) : null,
          valeur: valeur ? text(lire(e, valeur)) : null,
          etiquettes: etiquettes ? etiquettesDe(lire(e, etiquettes)) : [],
          lien: lien ? lienDe(lire(e, lien), t, ctx) : null,
        };
      });
    }
    case "tableau": {
      const columns = columnsOf(p.colonnes).slice(0, 8);
      const lien = champOpt(p, "lien");
      const r = collection(valeurDe(p.elements, ctx), ctx, (e) => {
        const valeurs: Record<string, string> = {};
        for (const c of columns) poser(valeurs, c.champ, text(readPath(e, c.champ)));
        return { valeurs, lien: lien === null ? null : lienDe(readPath(e, lien), "", ctx) };
      });
      return { colonnes: columns, ...r };
    }
    case "champs": {
      const object = objectOf(valeurDe(p.objet, ctx).valeur);
      const champs = a(p, "champs")
        ? columnsOf(p.champs).slice(0, 12).map((c) => ({ libelle: c.libelle, valeur: text(readPath(object, c.champ)) }))
        : Object.keys(object).filter((k) => primitive(object[k])).map((k) => ({ libelle: couper(k), valeur: text(object[k]) }));
      const others = Math.max(0, champs.length - ELEMENTS_MAX);
      ctx.coupes += others;
      return { champs: champs.slice(0, ELEMENTS_MAX), autres: others };
    }
    case "etiquettes": {
      if (a(p, "valeurs")) {
        const l = valeurDe(p.valeurs, ctx).valeur;
        if (!Array.isArray(l)) throw new Unreadable();
        return textsOf(l.filter(primitive), ctx, (e) => e);
      }
      const l = valeurDe(p.elements, ctx).valeur;
      if (!Array.isArray(l)) throw new Unreadable();
      const champ = champDe(p.champ);
      return textsOf(l, ctx, (e) => readPath(e, champ));
    }
    case "lien": {
      const object = objectOf(valeurDe(p.objet, ctx).valeur);
      const url = readPath(object, champDe(p.url));
      const label = a(p, "champTexte") ? text(readPath(object, champDe(p.champTexte))) : (literal(p, "texte") ?? "");
      return { lien: lienDe(url, label, ctx) };
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
  if (typeof v === "string") return couper(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null) return v;
  if (typeof v !== "object" || prof >= AGENT_DEPTH) return null;
  if (Array.isArray(v)) {
    if (v.length > ELEMENTS_MAX) ctx.coupes += v.length - ELEMENTS_MAX;
    return v.slice(0, ELEMENTS_MAX).map((e) => clamp(e, ctx, budget, prof + 1));
  }
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(v).slice(0, ELEMENTS_MAX)) poser(o, k, clamp((v as Record<string, unknown>)[k], ctx, budget, prof + 1));
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
      case "reference": props[name] = clamp(valeurDe(v, ctx).valeur, ctx, { noeuds: AGENT_NODES_MAX }); break;
      case "champ": props[name] = champDe(v); break;
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

function resolveBlocks(blocs: unknown, level: number, ctx: Context): RenderedBlock[] {
  if (!Array.isArray(blocs)) return [];
  const renders: RenderedBlock[] = [];
  for (const b of blocs as BlocPlan[]) {
    if (++ctx.blocs > MAX_BLOCS_PAGE) break;
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
  const blocs = resolveBlocks(plan?.blocs, 0, ctx);
  return { blocs, secours: o.secours, vide: emptyResults(results), coupes: ctx.coupes };
}
