import type { z } from "zod";
import { REGISTRE_BLOCS } from "./blocs/index.js";
import { PREFIXE_WORKFLOW_INVALIDE, Workflow, type GenreSortie } from "./schema.js";

export type WorkflowValide = {
  /** The workflow, params filled with the default values. */
  workflow: Workflow;
  /** Run order: topological sort, ties broken in the order of the `blocs` array. */
  ordre: string[];
  predecesseurs: Record<string, string[]>;
  sortie: { id: string; vers: GenreSortie };
};

/**
 * What the owner declares and that changes the rules: `sources.web`, `recolte.dureeMaxMinutes`, its kind (an
 * action returns a page, a widget does not) and, for an action, whether it declares a `saisie`.
 */
export type ContexteValidation = { web: boolean; dureeMaxMinutes: number | null; proprietaire: "widget" | "action"; saisie: boolean };

/** A widget without `web` or maximum duration: the rules from before. */
export const CONTEXTE_PAR_DEFAUT: ContexteValidation = { web: false, dureeMaxMinutes: null, proprietaire: "widget", saisie: false };

export const SORTIE_PAGE_REFUSEE = 'sortie : vers "page" seulement dans une action';
export const SORTIE_PAGE_REQUISE = 'sortie : une action rend une page (vers: "page")';
export const FIL_DE_L_EAU_ACTION = "sortie.auFilDeLEau : pas dans une action";

/** Refusal of a `web.chercher` block in a widget that does not declare `"web": true`. */
export const WEB_REQUIS = 'web.chercher : le widget doit déclarer "web": true';

/** The `budgetSecondes` of a block without a maximum duration of the widget. */
const BUDGET_MAX_SECONDES = 170;

/** `bloc`: the id of the block concerned, when the error targets one. */
export type ResultatValidation = { ok: true; valide: WorkflowValide } | { ok: false; erreur: string; bloc?: string };

const LONGUEUR_MAX_ERREUR = 300;

/** A validation error, prefixed and bounded. */
export function erreurWorkflow(cause: string, bloc?: string): { ok: false; erreur: string; bloc?: string } {
  const texte = PREFIXE_WORKFLOW_INVALIDE + cause;
  const erreur = texte.length > LONGUEUR_MAX_ERREUR ? texte.slice(0, LONGUEUR_MAX_ERREUR - 1) + "…" : texte;
  return bloc === undefined ? { ok: false, erreur } : { ok: false, erreur, bloc };
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
const pluriel = (n: unknown, mot: string) => `${String(n)} ${mot}${Number(n) > 1 ? "s" : ""}`;

/**
 * The message of a zod problem in short French, for the common cases. A message written in a schema (already in
 * French) is kept; an unforeseen case keeps zod's text.
 */
function enFrancais(p: z.core.$ZodIssue): string {
  if (!/^(Invalid|Too (big|small)|Unrecognized)/.test(p.message)) return p.message;
  const i = p as z.core.$ZodIssue & Record<string, unknown>;
  switch (p.code) {
    case "invalid_type": {
      const attendu = TYPES[String(i.expected)] ?? `${String(i.expected)} attendu`;
      return /received undefined$/.test(p.message) ? `manquant (${attendu})` : attendu;
    }
    case "too_big": {
      const n = i.maximum;
      if (i.origin === "array") return `${pluriel(n, "élément")} au plus`;
      if (i.origin === "string") return `${pluriel(n, "caractère")} au plus`;
      return i.inclusive === false ? `doit être inférieur à ${String(n)}` : `${String(n)} au plus`;
    }
    case "too_small": {
      const n = i.minimum;
      if (i.origin === "array") return `au moins ${pluriel(n, "élément")}`;
      if (i.origin === "string") return Number(n) === 1 ? "vide" : `au moins ${pluriel(n, "caractère")}`;
      return i.inclusive === false ? `doit être supérieur à ${String(n)}` : `au moins ${String(n)}`;
    }
    case "invalid_value": {
      const valeurs = (Array.isArray(i.values) ? i.values : []).map((v) => JSON.stringify(v)).join(", ");
      return Array.isArray(i.values) && i.values.length === 1 ? `${valeurs} attendu` : `une valeur parmi ${valeurs} attendue`;
    }
    case "unrecognized_keys":
      return "paramètre inconnu";
    default:
      return p.message;
  }
}

/** First zod problem, in the form « <chemin> : <message> ». */
function premierProbleme(erreur: z.ZodError, racine?: string): string {
  const p = erreur.issues[0]!;
  const chemin = [...p.path.map(String)];
  if (p.code === "unrecognized_keys") chemin.push(...p.keys.slice(0, 1));
  const message = enFrancais(p);
  const nom = [...(racine ? [racine] : []), ...chemin].join(".");
  return nom ? `${nom} : ${message}` : message;
}

/** A cycle among the remaining blocks, named « a → b → a », starting from the first in the array order. */
function nommerCycle(restants: string[], predecesseurs: Record<string, string[]>): { texte: string; premier: string } {
  const reste = new Set(restants);
  const vus: string[] = [];
  let courant = restants[0]!;
  while (!vus.includes(courant)) {
    vus.push(courant);
    courant = predecesseurs[courant]!.find((p) => reste.has(p))!;
  }
  // Going up the predecessors, we get the cycle backwards.
  const cycle = vus.slice(vus.indexOf(courant)).reverse();
  const depart = cycle.reduce((m, id, i) => (restants.indexOf(id) < restants.indexOf(cycle[m]!) ? i : m), 0);
  const tourne = [...cycle.slice(depart), ...cycle.slice(0, depart)];
  return { texte: [...tourne, tourne[0]!].join(" → "), premier: tourne[0]! };
}

export function validerWorkflow(brut: unknown, ctx: ContexteValidation = CONTEXTE_PAR_DEFAUT): ResultatValidation {
  const lu = Workflow.safeParse(brut);
  if (!lu.success) return erreurWorkflow(premierProbleme(lu.error));
  const workflow = lu.data;

  const ids = new Set<string>();
  for (const b of workflow.blocs) {
    if (ids.has(b.id)) return erreurWorkflow(`id de bloc en double : ${b.id}`, b.id);
    ids.add(b.id);
  }

  for (const b of workflow.blocs) {
    const definition = REGISTRE_BLOCS.get(b.type);
    if (!definition) return erreurWorkflow(`type inconnu : ${b.type}`, b.id);
    if (b.type === "web.chercher" && !ctx.web) return erreurWorkflow(WEB_REQUIS, b.id);
    if (definition.parElement === "non" && "parElement" in b.parametres) {
      return erreurWorkflow(`${b.id}.parElement : le type ${b.type} ne travaille pas élément par élément`, b.id);
    }
    const parametres = definition.parametres.safeParse(b.parametres);
    if (!parametres.success) return erreurWorkflow(premierProbleme(parametres.error, b.id), b.id);
    b.parametres = parametres.data as Record<string, unknown>;
    const p = b.parametres;
    const budgetMax = ctx.dureeMaxMinutes ? ctx.dureeMaxMinutes * 60 : BUDGET_MAX_SECONDES;
    if (typeof p.budgetSecondes === "number" && p.budgetSecondes > budgetMax) {
      return erreurWorkflow(`${b.id}.budgetSecondes : ${budgetMax} au plus`, b.id);
    }
    if (b.type !== "liste.nouveaux" && p.garderJours !== undefined && p.reutiliser === undefined) {
      return erreurWorkflow(`${b.id}.garderJours : seulement avec reutiliser`, b.id);
    }
  }

  const predecesseurs: Record<string, string[]> = Object.fromEntries(workflow.blocs.map((b) => [b.id, []]));
  for (const l of workflow.liens) {
    for (const bout of [l.de, l.vers]) {
      if (!ids.has(bout)) {
        const autre = bout === l.de ? l.vers : l.de;
        return erreurWorkflow(`lien vers un bloc absent : ${bout}`, ids.has(autre) ? autre : undefined);
      }
    }
    if (!predecesseurs[l.vers]!.includes(l.de)) predecesseurs[l.vers]!.push(l.de);
  }

  const sorties = workflow.blocs.filter((b) => b.type === "sortie");
  if (sorties.length === 0) return erreurWorkflow("aucune sortie");
  if (sorties.length > 1) return erreurWorkflow(`plusieurs sorties : ${sorties.map((b) => b.id).join(", ")}`);

  const paramsSortie = sorties[0]!.parametres as { vers: GenreSortie; auFilDeLEau?: boolean };
  if (ctx.proprietaire === "widget" && paramsSortie.vers === "page") return erreurWorkflow(SORTIE_PAGE_REFUSEE, sorties[0]!.id);
  if (ctx.proprietaire === "action") {
    if (paramsSortie.vers !== "page") return erreurWorkflow(SORTIE_PAGE_REQUISE, sorties[0]!.id);
    if (paramsSortie.auFilDeLEau === true) return erreurWorkflow(FIL_DE_L_EAU_ACTION, sorties[0]!.id);
  }

  // Kahn's sort: at each round, the first block (in array order) all of whose predecessors are placed.
  const ordre: string[] = [];
  const places = new Set<string>();
  let restants = workflow.blocs.map((b) => b.id);
  while (restants.length > 0) {
    const prochain = restants.find((id) => predecesseurs[id]!.every((p) => places.has(p)));
    if (prochain === undefined) {
      const cycle = nommerCycle(restants, predecesseurs);
      return erreurWorkflow(`cycle : ${cycle.texte}`, cycle.premier);
    }
    ordre.push(prochain);
    places.add(prochain);
    restants = restants.filter((id) => id !== prochain);
  }

  // Last: the other errors (params, links, cycle) come first.
  for (const b of workflow.blocs) {
    const entree = REGISTRE_BLOCS.get(b.type)!.entree;
    const requise = entree === "requise" || (entree === "parElement" && b.parametres.parElement === true);
    if (requise && predecesseurs[b.id]!.length === 0) return erreurWorkflow(`${b.id} : entrée manquante (relie un bloc avant lui)`, b.id);
  }

  const vers = paramsSortie.vers;
  return { ok: true, valide: { workflow, ordre, predecesseurs, sortie: { id: sorties[0]!.id, vers } } };
}

/** The workflow of a widget that only has `recolte.mjs`: harvest → sortie. */
export function workflowImplicite(): Workflow {
  return {
    version: 1,
    blocs: [
      { id: "recolte", type: "code", position: { x: 0, y: 0 }, parametres: { source: "recolte.mjs", appel: "recolte" } },
      { id: "sortie", type: "sortie", position: { x: 0, y: 0 }, parametres: { vers: "widget" } },
    ],
    liens: [{ de: "recolte", vers: "sortie" }],
  };
}
