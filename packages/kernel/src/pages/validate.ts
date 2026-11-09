import type { ComponentDefinition, Property } from "./catalogue.js";
import { PlanPage, evaluate, lireReference, readPath, type BlocPlan, type Group } from "./plan.js";

// The validation of Gemma's plan, which is hostile data (it may have read a booby-trapped page). Nothing throws: an
// unreadable plan returns `ok: false`. The reasons are written by WebAiOs and never quote a value of the results (only
// names of properties, fields and paths, written by the plan itself).

export const PLAN_REFERENCES_NOTHING = "le plan ne référence rien";
/** Bounds of the raw JSON, checked before zod (which overflows the stack on a plan nested thousands of levels deep). */
const RAW_DEPTH_MAX = 64;
const RAW_NODES_MAX = 50_000;
const MAX_ERRORS = 10;
const MAX_ERROR = 200;
const LABEL_MAX = 60;
const AGENT_TEXT_MAX = 400;

export type ValidationResult = { ok: true; plan: PlanPage; ecartes: string[] } | { ok: false; erreurs: string[] };

class Gap extends Error {}

/** Expected kind of a reference's value, per built-in component and property. */
const EXPECTED: Record<string, "liste" | "objet" | "simple"> = {
  "paragraphe.valeur": "simple", "chiffre.valeur": "simple", "encadre.elements": "liste",
  "liste.elements": "liste", "cartes.elements": "liste", "tableau.elements": "liste",
  "champs.objet": "objet", "etiquettes.valeurs": "liste", "etiquettes.elements": "liste", "lien.objet": "objet",
};
/** The property that carries the items where its fields are read. */
const SOURCE: Record<string, string> = {
  encadre: "elements", liste: "elements", cartes: "elements", tableau: "elements", etiquettes: "elements", lien: "objet", champs: "objet",
};
const CHILDREN: Record<string, ("blocs" | "gauche" | "droite")[]> = { groupe: ["blocs"], colonnes: ["gauche", "droite"] };

function couper(s: string): string {
  return s.length > MAX_ERROR ? s.slice(0, MAX_ERROR - 1) + "…" : s;
}

/** A raw JSON small and shallow enough to be read without risk; otherwise the reason. Iterative. */
function precheck(brut: unknown): string | null {
  const pile: [unknown, number][] = [[brut, 0]];
  let nodes = 0;
  while (pile.length > 0) {
    const [v, prof] = pile.pop()!;
    if (++nodes > RAW_NODES_MAX) return "plan trop gros";
    if (v === null || typeof v !== "object") continue;
    if (prof >= RAW_DEPTH_MAX) return "plan imbriqué trop profondément";
    if (Array.isArray(v)) {
      if (v.length > RAW_NODES_MAX) return "plan trop gros";
      for (const e of v) pile.push([e, prof + 1]);
    } else {
      for (const k of Object.keys(v)) pile.push([(v as Record<string, unknown>)[k], prof + 1]);
    }
  }
  return null;
}

const primitive = (v: unknown) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const present = (props: Record<string, unknown>, name: string) => Object.hasOwn(props, name) && props[name] !== undefined && props[name] !== null;

/** A reference read and computed; its value checked according to `attendu`. */
function verifierReference(text: unknown, expected: "liste" | "objet" | "simple" | undefined, results: unknown) {
  if (typeof text !== "string") throw new Gap("référence attendue (un texte)");
  const ref = lireReference(text);
  if ("erreur" in ref) throw new Gap(ref.erreur);
  const r = evaluate(ref, results);
  if ("erreur" in r) throw new Gap(r.erreur);
  const v = r.valeur;
  if (expected === "liste" && !Array.isArray(v)) throw new Gap("liste attendue");
  if (expected === "objet" && (v === null || typeof v !== "object" || Array.isArray(v))) throw new Gap("objet attendu");
  if (expected === "simple" && !primitive(v)) throw new Gap("valeur simple attendue");
  return { texte: text, valeur: v, groupee: ref.ops.at(-1)?.op === "regrouper" };
}

/** A field: a path relative to an item, never a reference nor a free text (an address written by Gemma fails here). */
function lireChamp(text: unknown): string {
  if (typeof text !== "string") throw new Gap("nom de champ attendu");
  const ref = lireReference(text);
  if ("erreur" in ref) throw new Gap(ref.erreur);
  if (ref.ops.length > 0) throw new Gap("un nom de champ est attendu, pas une référence");
  if (ref.chemin === "$") throw new Gap("nom de champ attendu");
  return ref.chemin;
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

function verifierProps(def: ComponentDefinition, brutes: Record<string, unknown>, results: unknown): Checked {
  const props: Record<string, unknown> = {};
  const valeurs: Record<string, { valeur: unknown; groupee: boolean }> = {};
  const champsAVerifier: { nom: string; champ: string }[] = [];
  let reference = false;
  const builtIn = def.origine === "integre";

  for (const [name, pr] of Object.entries(def.proprietes) as [string, Property][]) {
    if (!present(brutes, name)) {
      if (pr.requis) throw new Gap(`${name} : requise`);
      continue;
    }
    const v = brutes[name];
    try {
      switch (pr.genre) {
        case "reference": {
          // « $ » given to a paragraph: all the results as compact text, the last-resort layout.
          const expected = builtIn && !(def.nom === "paragraphe" && v === "$") ? EXPECTED[`${def.nom}.${name}`] : undefined;
          const r = verifierReference(v, expected, results);
          props[name] = r.texte;
          valeurs[name] = r;
          reference = true;
          break;
        }
        case "champ":
          props[name] = lireChamp(v);
          champsAVerifier.push({ nom: name, champ: props[name] as string });
          break;
        case "texte":
          props[name] = checkText(v, pr.max ?? AGENT_TEXT_MAX);
          break;
        case "nombre":
          if (typeof v !== "number" || !Number.isFinite(v)) throw new Gap("nombre attendu");
          props[name] = v;
          break;
        case "case":
          if (typeof v !== "boolean") throw new Gap("vrai ou faux attendu");
          props[name] = v;
          break;
        case "choix": {
          const choice = pr.choix ?? [];
          if (typeof v !== "string" || !choice.includes(v)) {
            throw new Gap(`${choice.slice(0, -1).join(", ")}${choice.length > 1 ? " ou " : ""}${choice.at(-1) ?? ""} attendu`);
          }
          props[name] = v;
          break;
        }
        case "colonnes": {
          const forme = "{ champ, libelle }";
          props[name] = checkList(v, pr.max ?? 8, forme).map((e) => {
            const o = objectOf(e, forme);
            const champ = lireChamp(o.champ);
            const label = present(o, "libelle") ? checkText(o.libelle, LABEL_MAX) : champ;
            champsAVerifier.push({ nom: name, champ });
            return { champ, libelle: label };
          });
          break;
        }
        case "chiffres": {
          const forme = "{ valeur, libelle }";
          props[name] = checkList(v, pr.max ?? 6, forme).map((e) => {
            const o = objectOf(e, forme);
            if (!present(o, "valeur")) throw new Gap("valeur requise");
            if (!present(o, "libelle")) throw new Gap("libelle requis");
            const valeur = verifierReference(o.valeur, "simple", results).texte;
            return { valeur, libelle: checkText(o.libelle, LABEL_MAX) };
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

  if (builtIn) applyRules(def.nom, props);

  // A field must exist in at least one item of the referenced list (an empty list says nothing).
  const source = builtIn ? SOURCE[def.nom] : undefined;
  const lue = source !== undefined && Object.hasOwn(props, source) ? valeurs[source] : undefined;
  if (lue) {
    const elements = elementsDe(lue);
    for (const { nom: name, champ } of champsAVerifier) {
      if (!Object.hasOwn(props, name)) continue;
      if (elements.length > 0 && !elements.some((e) => readPath(e, champ) !== undefined)) {
        throw new Gap(`${name} : champ « ${champ} » absent de tous les éléments`);
      }
    }
  }
  return { props, reference };
}

function elementsDe(lue: { valeur: unknown; groupee: boolean }): unknown[] {
  if (!Array.isArray(lue.valeur)) return [lue.valeur];
  if (!lue.groupee) return lue.valeur;
  return (lue.valeur as Group<unknown>[]).flatMap((g) => g.elements);
}

/** The catalog's « one or the other » rules. */
function applyRules(name: string, props: Record<string, unknown>): void {
  const a = (k: string) => Object.hasOwn(props, k);
  switch (name) {
    case "paragraphe":
      if (!a("texte") && !a("valeur")) throw new Gap("texte ou valeur attendu");
      if (a("valeur")) delete props.texte;
      break;
    case "etiquettes":
      if (a("valeurs")) { delete props.elements; delete props.champ; break; }
      if (!a("elements") || !a("champ")) throw new Gap("valeurs, ou elements avec champ, attendu");
      break;
    case "encadre":
      if (a("elements") !== a("champ")) throw new Gap("elements et champ vont ensemble");
      break;
    case "lien":
      if (a("champTexte")) delete props.texte;
      break;
  }
}

function compterBlocs(b: BlocPlan): number {
  let n = 0;
  for (const l of [b.blocs, b.gauche, b.droite]) for (const e of l ?? []) n += 1 + compterBlocs(e);
  return n;
}

type Context = { defs: Map<string, ComponentDefinition>; resultats: unknown; ecartes: string[]; n: number; references: number };

function validateBlocks(blocs: BlocPlan[], ctx: Context): BlocPlan[] {
  const guards: BlocPlan[] = [];
  for (const b of blocs) {
    const n = ++ctx.n;
    const def = ctx.defs.get(b.composant);
    if (!def) {
      // Unknown: kept (drawn as an error box), its children will not be drawn.
      ctx.n += compterBlocs(b);
      guards.push({ composant: b.composant, props: Object.fromEntries(Object.entries(b.props)) });
      continue;
    }
    let v: Checked;
    try {
      v = verifierProps(def, b.props, ctx.resultats);
    } catch (e) {
      if (!(e instanceof Gap)) throw e;
      ctx.ecartes.push(couper(`${n}. ${b.composant} : ${e.message}`));
      ctx.n += compterBlocs(b);
      continue;
    }
    if (v.reference) ctx.references++;
    const kept: BlocPlan = { composant: b.composant, props: v.props };
    const children = def.origine === "integre" ? (CHILDREN[def.nom] ?? []) : [];
    for (const key of ["blocs", "gauche", "droite"] as const) {
      const list = b[key];
      if (list === undefined) continue;
      if (children.includes(key)) kept[key] = validateBlocks(list, ctx);
      else ctx.n += list.reduce((s, e) => s + 1 + compterBlocs(e), 0);
    }
    guards.push(kept);
  }
  return guards;
}

export function validatePlan(brut: unknown, o: { catalogue: ComponentDefinition[]; resultats: unknown }): ValidationResult {
  try {
    const too = precheck(brut);
    if (too) return { ok: false, erreurs: [too] };
    const r = PlanPage.safeParse(brut);
    if (!r.success) {
      return {
        ok: false,
        erreurs: r.error.issues.slice(0, MAX_ERRORS).map((i) => couper(i.path.length ? `${i.path.join(".")} : ${i.message}` : i.message)),
      };
    }
    const ctx: Context = { defs: new Map(o.catalogue.map((d) => [d.nom, d])), resultats: o.resultats, ecartes: [], n: 0, references: 0 };
    const blocs = validateBlocks(r.data.blocs, ctx);
    if (ctx.references === 0) return { ok: false, erreurs: [PLAN_REFERENCES_NOTHING, ...ctx.ecartes] };
    return { ok: true, plan: { blocs }, ecartes: ctx.ecartes };
  } catch {
    return { ok: false, erreurs: ["plan illisible"] };
  }
}
