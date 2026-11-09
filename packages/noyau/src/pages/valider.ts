import type { DefinitionComposant, Propriete } from "./catalogue.js";
import { PlanPage, evaluer, lireReference, lireChemin, type BlocPlan, type Groupe } from "./plan.js";

// The validation of Gemma's plan, which is hostile data (it may have read a booby-trapped page). Nothing throws: an
// unreadable plan returns `ok: false`. The reasons are written by WebAiOs and never quote a value of the results (only
// names of properties, fields and paths, written by the plan itself).

export const PLAN_NE_REFERENCE_RIEN = "le plan ne référence rien";
/** Bounds of the raw JSON, checked before zod (which overflows the stack on a plan nested thousands of levels deep). */
const PROFONDEUR_BRUT_MAX = 64;
const NOEUDS_BRUT_MAX = 50_000;
const ERREURS_MAX = 10;
const ERREUR_MAX = 200;
const LIBELLE_MAX = 60;
const TEXTE_AGENT_MAX = 400;

export type ResultatValidation = { ok: true; plan: PlanPage; ecartes: string[] } | { ok: false; erreurs: string[] };

class Ecart extends Error {}

/** Expected kind of a reference's value, per built-in component and property. */
const ATTENDU: Record<string, "liste" | "objet" | "simple"> = {
  "paragraphe.valeur": "simple", "chiffre.valeur": "simple", "encadre.elements": "liste",
  "liste.elements": "liste", "cartes.elements": "liste", "tableau.elements": "liste",
  "champs.objet": "objet", "etiquettes.valeurs": "liste", "etiquettes.elements": "liste", "lien.objet": "objet",
};
/** The property that carries the items where its fields are read. */
const SOURCE: Record<string, string> = {
  encadre: "elements", liste: "elements", cartes: "elements", tableau: "elements", etiquettes: "elements", lien: "objet", champs: "objet",
};
const ENFANTS: Record<string, ("blocs" | "gauche" | "droite")[]> = { groupe: ["blocs"], colonnes: ["gauche", "droite"] };

function couper(s: string): string {
  return s.length > ERREUR_MAX ? s.slice(0, ERREUR_MAX - 1) + "…" : s;
}

/** A raw JSON small and shallow enough to be read without risk; otherwise the reason. Iterative. */
function preverifier(brut: unknown): string | null {
  const pile: [unknown, number][] = [[brut, 0]];
  let noeuds = 0;
  while (pile.length > 0) {
    const [v, prof] = pile.pop()!;
    if (++noeuds > NOEUDS_BRUT_MAX) return "plan trop gros";
    if (v === null || typeof v !== "object") continue;
    if (prof >= PROFONDEUR_BRUT_MAX) return "plan imbriqué trop profondément";
    if (Array.isArray(v)) {
      if (v.length > NOEUDS_BRUT_MAX) return "plan trop gros";
      for (const e of v) pile.push([e, prof + 1]);
    } else {
      for (const k of Object.keys(v)) pile.push([(v as Record<string, unknown>)[k], prof + 1]);
    }
  }
  return null;
}

const primitif = (v: unknown) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const presente = (props: Record<string, unknown>, nom: string) => Object.hasOwn(props, nom) && props[nom] !== undefined && props[nom] !== null;

/** A reference read and computed; its value checked according to `attendu`. */
function verifierReference(texte: unknown, attendu: "liste" | "objet" | "simple" | undefined, resultats: unknown) {
  if (typeof texte !== "string") throw new Ecart("référence attendue (un texte)");
  const ref = lireReference(texte);
  if ("erreur" in ref) throw new Ecart(ref.erreur);
  const r = evaluer(ref, resultats);
  if ("erreur" in r) throw new Ecart(r.erreur);
  const v = r.valeur;
  if (attendu === "liste" && !Array.isArray(v)) throw new Ecart("liste attendue");
  if (attendu === "objet" && (v === null || typeof v !== "object" || Array.isArray(v))) throw new Ecart("objet attendu");
  if (attendu === "simple" && !primitif(v)) throw new Ecart("valeur simple attendue");
  return { texte, valeur: v, groupee: ref.ops.at(-1)?.op === "regrouper" };
}

/** A field: a path relative to an item, never a reference nor a free text (an address written by Gemma fails here). */
function lireChamp(texte: unknown): string {
  if (typeof texte !== "string") throw new Ecart("nom de champ attendu");
  const ref = lireReference(texte);
  if ("erreur" in ref) throw new Ecart(ref.erreur);
  if (ref.ops.length > 0) throw new Ecart("un nom de champ est attendu, pas une référence");
  if (ref.chemin === "$") throw new Ecart("nom de champ attendu");
  return ref.chemin;
}

function verifierTexte(v: unknown, max: number): string {
  if (typeof v !== "string") throw new Ecart("texte attendu");
  if (v.length > max) throw new Ecart(`trop long (plus de ${max} caractères)`);
  return v;
}

function verifierListe(v: unknown, max: number, forme: string): unknown[] {
  if (!Array.isArray(v) || v.length === 0) throw new Ecart(`liste de ${forme} attendue`);
  if (v.length > max) throw new Ecart(`${max} au plus`);
  return v;
}

function objetDe(v: unknown, forme: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Ecart(`liste de ${forme} attendue`);
  return v as Record<string, unknown>;
}

type Verifiees = { props: Record<string, unknown>; reference: boolean };

function verifierProps(def: DefinitionComposant, brutes: Record<string, unknown>, resultats: unknown): Verifiees {
  const props: Record<string, unknown> = {};
  const valeurs: Record<string, { valeur: unknown; groupee: boolean }> = {};
  const champsAVerifier: { nom: string; champ: string }[] = [];
  let reference = false;
  const integre = def.origine === "integre";

  for (const [nom, pr] of Object.entries(def.proprietes) as [string, Propriete][]) {
    if (!presente(brutes, nom)) {
      if (pr.requis) throw new Ecart(`${nom} : requise`);
      continue;
    }
    const v = brutes[nom];
    try {
      switch (pr.genre) {
        case "reference": {
          // « $ » given to a paragraph: all the results as compact text, the last-resort layout.
          const attendu = integre && !(def.nom === "paragraphe" && v === "$") ? ATTENDU[`${def.nom}.${nom}`] : undefined;
          const r = verifierReference(v, attendu, resultats);
          props[nom] = r.texte;
          valeurs[nom] = r;
          reference = true;
          break;
        }
        case "champ":
          props[nom] = lireChamp(v);
          champsAVerifier.push({ nom, champ: props[nom] as string });
          break;
        case "texte":
          props[nom] = verifierTexte(v, pr.max ?? TEXTE_AGENT_MAX);
          break;
        case "nombre":
          if (typeof v !== "number" || !Number.isFinite(v)) throw new Ecart("nombre attendu");
          props[nom] = v;
          break;
        case "case":
          if (typeof v !== "boolean") throw new Ecart("vrai ou faux attendu");
          props[nom] = v;
          break;
        case "choix": {
          const choix = pr.choix ?? [];
          if (typeof v !== "string" || !choix.includes(v)) {
            throw new Ecart(`${choix.slice(0, -1).join(", ")}${choix.length > 1 ? " ou " : ""}${choix.at(-1) ?? ""} attendu`);
          }
          props[nom] = v;
          break;
        }
        case "colonnes": {
          const forme = "{ champ, libelle }";
          props[nom] = verifierListe(v, pr.max ?? 8, forme).map((e) => {
            const o = objetDe(e, forme);
            const champ = lireChamp(o.champ);
            const libelle = presente(o, "libelle") ? verifierTexte(o.libelle, LIBELLE_MAX) : champ;
            champsAVerifier.push({ nom, champ });
            return { champ, libelle };
          });
          break;
        }
        case "chiffres": {
          const forme = "{ valeur, libelle }";
          props[nom] = verifierListe(v, pr.max ?? 6, forme).map((e) => {
            const o = objetDe(e, forme);
            if (!presente(o, "valeur")) throw new Ecart("valeur requise");
            if (!presente(o, "libelle")) throw new Ecart("libelle requis");
            const valeur = verifierReference(o.valeur, "simple", resultats).texte;
            return { valeur, libelle: verifierTexte(o.libelle, LIBELLE_MAX) };
          });
          reference = true;
          break;
        }
      }
    } catch (e) {
      if (e instanceof Ecart) throw new Ecart(`${nom} : ${e.message}`);
      throw e;
    }
  }

  if (integre) appliquerRegles(def.nom, props);

  // A field must exist in at least one item of the referenced list (an empty list says nothing).
  const source = integre ? SOURCE[def.nom] : undefined;
  const lue = source !== undefined && Object.hasOwn(props, source) ? valeurs[source] : undefined;
  if (lue) {
    const elements = elementsDe(lue);
    for (const { nom, champ } of champsAVerifier) {
      if (!Object.hasOwn(props, nom)) continue;
      if (elements.length > 0 && !elements.some((e) => lireChemin(e, champ) !== undefined)) {
        throw new Ecart(`${nom} : champ « ${champ} » absent de tous les éléments`);
      }
    }
  }
  return { props, reference };
}

function elementsDe(lue: { valeur: unknown; groupee: boolean }): unknown[] {
  if (!Array.isArray(lue.valeur)) return [lue.valeur];
  if (!lue.groupee) return lue.valeur;
  return (lue.valeur as Groupe<unknown>[]).flatMap((g) => g.elements);
}

/** The catalog's « one or the other » rules. */
function appliquerRegles(nom: string, props: Record<string, unknown>): void {
  const a = (k: string) => Object.hasOwn(props, k);
  switch (nom) {
    case "paragraphe":
      if (!a("texte") && !a("valeur")) throw new Ecart("texte ou valeur attendu");
      if (a("valeur")) delete props.texte;
      break;
    case "etiquettes":
      if (a("valeurs")) { delete props.elements; delete props.champ; break; }
      if (!a("elements") || !a("champ")) throw new Ecart("valeurs, ou elements avec champ, attendu");
      break;
    case "encadre":
      if (a("elements") !== a("champ")) throw new Ecart("elements et champ vont ensemble");
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

type Contexte = { defs: Map<string, DefinitionComposant>; resultats: unknown; ecartes: string[]; n: number; references: number };

function validerBlocs(blocs: BlocPlan[], ctx: Contexte): BlocPlan[] {
  const gardes: BlocPlan[] = [];
  for (const b of blocs) {
    const n = ++ctx.n;
    const def = ctx.defs.get(b.composant);
    if (!def) {
      // Unknown: kept (drawn as an error box), its children will not be drawn.
      ctx.n += compterBlocs(b);
      gardes.push({ composant: b.composant, props: Object.fromEntries(Object.entries(b.props)) });
      continue;
    }
    let v: Verifiees;
    try {
      v = verifierProps(def, b.props, ctx.resultats);
    } catch (e) {
      if (!(e instanceof Ecart)) throw e;
      ctx.ecartes.push(couper(`${n}. ${b.composant} : ${e.message}`));
      ctx.n += compterBlocs(b);
      continue;
    }
    if (v.reference) ctx.references++;
    const garde: BlocPlan = { composant: b.composant, props: v.props };
    const enfants = def.origine === "integre" ? (ENFANTS[def.nom] ?? []) : [];
    for (const cle of ["blocs", "gauche", "droite"] as const) {
      const liste = b[cle];
      if (liste === undefined) continue;
      if (enfants.includes(cle)) garde[cle] = validerBlocs(liste, ctx);
      else ctx.n += liste.reduce((s, e) => s + 1 + compterBlocs(e), 0);
    }
    gardes.push(garde);
  }
  return gardes;
}

export function validerPlan(brut: unknown, o: { catalogue: DefinitionComposant[]; resultats: unknown }): ResultatValidation {
  try {
    const trop = preverifier(brut);
    if (trop) return { ok: false, erreurs: [trop] };
    const r = PlanPage.safeParse(brut);
    if (!r.success) {
      return {
        ok: false,
        erreurs: r.error.issues.slice(0, ERREURS_MAX).map((i) => couper(i.path.length ? `${i.path.join(".")} : ${i.message}` : i.message)),
      };
    }
    const ctx: Contexte = { defs: new Map(o.catalogue.map((d) => [d.nom, d])), resultats: o.resultats, ecartes: [], n: 0, references: 0 };
    const blocs = validerBlocs(r.data.blocs, ctx);
    if (ctx.references === 0) return { ok: false, erreurs: [PLAN_NE_REFERENCE_RIEN, ...ctx.ecartes] };
    return { ok: true, plan: { blocs }, ecartes: ctx.ecartes };
  } catch {
    return { ok: false, erreurs: ["plan illisible"] };
  }
}
