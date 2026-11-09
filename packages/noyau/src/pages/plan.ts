import { z } from "zod";

// Gemma's page plan: its shape (zod), the small language of references and their evaluation. Pure: no input-output,
// nothing is ever evaluated as code; references only read own properties.

export const MAX_OPERATIONS = 4;
export const MAX_BLOCS_PAGE = 40;
export const PROFONDEUR_PAGE = 2;
export const REFERENCE_MAX = 300;
const PROPS_MAX = 20;
const GARDER_MAX = 200;
export const SANS_VALEUR = "(sans valeur)";

export type Operation =
  | { op: "compter" }
  | { op: "trier"; champ: string; desc: boolean }
  | { op: "garder"; n: number }
  | { op: "filtrer"; champ: string; comparaison: "=" | "~" | ">" | "<"; valeur: string | number }
  | { op: "regrouper"; champ: string };
/** `ops`: from the inside to the outside. */
export type Reference = { chemin: string; ops: Operation[] };
export type Groupe<T> = { valeur: string; elements: T[] };

// ---- Reading references ----

type Jeton =
  | { t: "mot"; v: string }
  | { t: "nombre"; v: number }
  | { t: "texte"; v: string }
  | { t: "sym"; v: "(" | ")" | "," | "." | "$" | "=" | "~" | ">" | "<" };

const MOT = /^[\p{L}\p{N}_]+$/u;

function decouper(texte: string): Jeton[] | string {
  const jetons: Jeton[] = [];
  let i = 0;
  while (i < texte.length) {
    const c = texte[i]!;
    if (/\s/u.test(c)) { i++; continue; }
    if ("(),.$=~><".includes(c)) { jetons.push({ t: "sym", v: c as never }); i++; continue; }
    if (c === '"') {
      const fin = texte.indexOf('"', i + 1);
      if (fin < 0) return "texte entre guillemets non fermé";
      jetons.push({ t: "texte", v: texte.slice(i + 1, fin) });
      i = fin + 1;
      continue;
    }
    const nombre = /^-?\d+(?:\.\d+)?(?![\p{L}\p{N}_])/u.exec(texte.slice(i));
    if (nombre) { jetons.push({ t: "nombre", v: Number(nombre[0]) }); i += nombre[0].length; continue; }
    let j = i;
    while (j < texte.length && MOT.test(texte[j]!)) j++;
    if (j === i) return `caractère inattendu « ${c} »`;
    jetons.push({ t: "mot", v: texte.slice(i, j) });
    i = j;
  }
  return jetons;
}

class Erreur extends Error {}
const OPERATIONS = ["compter", "trier", "garder", "filtrer", "regrouper"];

class Lecteur {
  private i = 0;
  constructor(private readonly jetons: Jeton[]) {}
  private pos() { return this.jetons[this.i]; }
  private sym(v: string): boolean { const j = this.pos(); return j?.t === "sym" && j.v === v; }
  private attendre(v: string): void {
    if (!this.sym(v)) throw new Erreur(`« ${v} » attendu`);
    this.i++;
  }
  fini(): boolean { return this.i >= this.jetons.length; }

  /** A path of `mot` segments separated by dots (whole numbers allowed: list indexes). */
  private segments(): string {
    const morceaux: string[] = [];
    for (;;) {
      const j = this.pos();
      let seg: string;
      if (j?.t === "mot") seg = j.v;
      else if (j?.t === "nombre" && Number.isInteger(j.v) && j.v >= 0) seg = String(j.v);
      else throw new Erreur("nom de champ attendu");
      this.i++;
      morceaux.push(seg);
      if (!this.sym(".")) break;
      this.i++;
    }
    return morceaux.join(".");
  }

  champ(): string { return this.segments(); }

  reference(): Reference {
    if (this.sym("$")) { this.i++; return { chemin: "$", ops: [] }; }
    const j = this.jetons[this.i];
    const suivant = this.jetons[this.i + 1];
    if (j?.t === "mot" && OPERATIONS.includes(j.v) && suivant?.t === "sym" && suivant.v === "(") {
      this.i += 2;
      const interieur = this.reference();
      const op = this.arguments(j.v);
      this.attendre(")");
      interieur.ops.push(op);
      if (interieur.ops.length > MAX_OPERATIONS) throw new Erreur(`plus de ${MAX_OPERATIONS} opérations imbriquées`);
      return interieur;
    }
    return { chemin: this.segments(), ops: [] };
  }

  private virgule(): void { this.attendre(","); }

  private arguments(nom: string): Operation {
    switch (nom) {
      case "compter": return { op: "compter" };
      case "regrouper": this.virgule(); return { op: "regrouper", champ: this.champ() };
      case "trier": {
        this.virgule();
        const champ = this.champ();
        let desc = false;
        if (this.sym(",")) {
          this.i++;
          const j = this.pos();
          if ((j?.t === "texte" || j?.t === "mot") && j.v === "desc") { desc = true; this.i++; }
          else throw new Erreur('seul "desc" est permis comme troisième argument de trier');
        }
        return { op: "trier", champ, desc };
      }
      case "garder": {
        this.virgule();
        const j = this.pos();
        if (j?.t !== "nombre" || !Number.isInteger(j.v) || j.v < 1 || j.v > GARDER_MAX) {
          throw new Erreur(`garder : un entier de 1 à ${GARDER_MAX} est attendu`);
        }
        this.i++;
        return { op: "garder", n: j.v };
      }
      default: {
        this.virgule();
        const champ = this.champ();
        const c = this.pos();
        if (c?.t !== "sym" || !["=", "~", ">", "<"].includes(c.v)) throw new Erreur("filtrer : = ~ > ou < attendu");
        this.i++;
        const v = this.pos();
        if (v?.t !== "nombre" && v?.t !== "texte" && v?.t !== "mot") throw new Erreur("filtrer : valeur attendue");
        this.i++;
        const comparaison = c.v as "=" | "~" | ">" | "<";
        if ((comparaison === ">" || comparaison === "<") && v.t !== "nombre") throw new Erreur("filtrer : un nombre est attendu avec > et <");
        return { op: "filtrer", champ, comparaison, valeur: v.v };
      }
    }
  }
}

export function lireReference(texte: string): Reference | { erreur: string } {
  if (typeof texte !== "string") return { erreur: "référence : texte attendu" };
  if (texte.length > REFERENCE_MAX) return { erreur: `référence trop longue (plus de ${REFERENCE_MAX} caractères)` };
  const jetons = decouper(texte);
  if (typeof jetons === "string") return { erreur: jetons };
  try {
    const lecteur = new Lecteur(jetons);
    const ref = lecteur.reference();
    if (!lecteur.fini()) throw new Erreur("texte en trop après la référence");
    return ref;
  } catch (e) {
    if (e instanceof Erreur) return { erreur: e.message };
    throw e;
  }
}

// ---- Reading and evaluation ----

/** Value at the end of a path `a.b.0`; `$` is the root. Own properties only (never the prototype, never `length`). */
export function lireChemin(valeur: unknown, chemin: string): unknown {
  if (chemin === "$") return valeur;
  let v = valeur;
  for (const morceau of chemin.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    if (Array.isArray(v) && !/^\d+$/.test(morceau)) return undefined;
    if (!Object.hasOwn(v, morceau)) return undefined;
    v = (v as Record<string, unknown>)[morceau];
  }
  return v;
}

const absent = (v: unknown) => v === undefined || v === null;
const primitif = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const normaliser = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const collateur = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

function comparer(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return collateur.compare(String(a), String(b));
}

function nombreDe(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function appliquer(op: Operation, entree: unknown): unknown {
  if (!Array.isArray(entree)) throw new Erreur(`${op.op} : liste attendue`);
  switch (op.op) {
    case "compter": return entree.length;
    case "garder": return entree.slice(0, op.n);
    case "trier": {
      const cles = entree.map((e, i) => ({ e, i, k: lireChemin(e, op.champ) }));
      const sens = op.desc ? -1 : 1;
      cles.sort((x, y) => {
        const ax = absent(x.k) || !primitif(x.k), ay = absent(y.k) || !primitif(y.k);
        if (ax || ay) return ax === ay ? x.i - y.i : ax ? 1 : -1;
        return sens * comparer(x.k, y.k) || x.i - y.i;
      });
      return cles.map((c) => c.e);
    }
    case "filtrer": {
      const { champ, comparaison, valeur } = op;
      const cherche = comparaison === "~" ? normaliser(String(valeur)) : "";
      return entree.filter((e) => {
        const v = lireChemin(e, champ);
        if (!primitif(v)) return false;
        if (comparaison === "~") return normaliser(String(v)).includes(cherche);
        if (comparaison === "=") return String(v) === String(valeur);
        const n = nombreDe(v);
        return n !== null && (comparaison === ">" ? n > (valeur as number) : n < (valeur as number));
      });
    }
    case "regrouper": {
      const groupes = new Map<string, unknown[]>();
      for (const e of entree) {
        const v = lireChemin(e, op.champ);
        const cle = primitif(v) && v !== "" ? String(v) : SANS_VALEUR;
        const g = groupes.get(cle);
        if (g) g.push(e);
        else groupes.set(cle, [e]);
      }
      return [...groupes].map(([valeur, elements]): Groupe<unknown> => ({ valeur, elements }));
    }
  }
}

/** Computes a reference on the results, without ever modifying them. */
export function evaluer(ref: Reference, resultats: unknown): { valeur: unknown } | { erreur: string } {
  let valeur = lireChemin(resultats, ref.chemin);
  if (valeur === undefined) return { erreur: `chemin absent : ${ref.chemin}` };
  try {
    for (const op of ref.ops) valeur = appliquer(op, valeur);
  } catch (e) {
    if (e instanceof Erreur) return { erreur: e.message };
    throw e;
  }
  return { valeur };
}

// ---- The plan ----

export type BlocPlan = { composant: string; props: Record<string, unknown>; blocs?: BlocPlan[]; gauche?: BlocPlan[]; droite?: BlocPlan[] };
export type PlanPage = { blocs: BlocPlan[] };

const BlocPlanSchema: z.ZodType<BlocPlan> = z.lazy(() =>
  z.object({
    composant: z.string().regex(/^[a-z0-9-]{1,40}$/),
    props: z.record(z.string(), z.unknown()).refine((p) => Object.keys(p).length <= PROPS_MAX, `${PROPS_MAX} propriétés au plus`),
    blocs: z.array(BlocPlanSchema).optional(),
    gauche: z.array(BlocPlanSchema).optional(),
    droite: z.array(BlocPlanSchema).optional(),
  }),
);

const CONTENEURS = ["groupe", "colonnes"];

/** Total number of blocks, and greatest nesting depth of containers (the page does not count). */
function mesurer(blocs: BlocPlan[], niveau: number): { total: number; trop: boolean } {
  let total = 0;
  let trop = false;
  for (const b of blocs) {
    total++;
    const enfants = [b.blocs, b.gauche, b.droite].filter((l): l is BlocPlan[] => l !== undefined);
    if (CONTENEURS.includes(b.composant) || enfants.length > 0) {
      if (niveau >= PROFONDEUR_PAGE) trop = true;
    }
    for (const liste of enfants) {
      const m = mesurer(liste, niveau + 1);
      total += m.total;
      trop ||= m.trop;
    }
  }
  return { total, trop };
}

export const PlanPage = z
  .object({ blocs: z.array(BlocPlanSchema).min(1) })
  .superRefine((plan, ctx) => {
    const { total, trop } = mesurer(plan.blocs, 0);
    if (total > MAX_BLOCS_PAGE) ctx.addIssue({ code: "custom", message: `plus de ${MAX_BLOCS_PAGE} blocs` });
    if (trop) ctx.addIssue({ code: "custom", message: `blocs imbriqués sur plus de ${PROFONDEUR_PAGE} niveaux` });
  });
