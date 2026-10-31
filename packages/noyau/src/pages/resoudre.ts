import { adresseLocale } from "../workflows/acces.js";
import type { DefinitionComposant } from "./catalogue.js";
import { MAX_BLOCS_PAGE, PROFONDEUR_PAGE, evaluer, lireChemin, lireReference, type BlocPlan, type Groupe, type PlanPage } from "./plan.js";

// La résolution d'un plan (validé, ou relu d'une exécution) en page rendue : références calculées, champs lus, textes
// bornés. Les règles de fuite (spec 3.7) sont ici : un lien n'a d'adresse que si elle figure telle quelle dans les
// résultats, en http(s), hors adresse locale ; une image seulement en https, et jamais pour une action avec compte.
// Ne lève jamais : un bloc qui ne se résout pas devient un encadré d'erreur, le reste de la page s'affiche.

export const ELEMENTS_MAX = 200;
export const TEXTE_MAX = 2000;
export const AUCUN_RESULTAT = "Aucun résultat";
export const MENTION_SECOURS = "mise en page simple";
export const COMPOSANT_INDISPONIBLE = (nom: string) => `Composant indisponible : ${nom}`;
export const BLOC_ILLISIBLE = (nom: string) => `Bloc illisible : ${nom}`;
const URL_MAX = 4096;
const ETIQUETTES_CARTE_MAX = 20;
/** Bornes de la valeur d'une référence donnée à un composant de l'agent. */
const PROFONDEUR_AGENT = 30;
const NOEUDS_AGENT_MAX = 5000;

export type { Groupe };
/** `url` null : lien inerte (texte seul). */
export type Lien = { texte: string; url: string | null };
export type Image = { url: string } | { neutre: true } | null;
export type BlocRendu =
  | { composant: string; props: Record<string, unknown>; blocs?: BlocRendu[]; gauche?: BlocRendu[]; droite?: BlocRendu[] }
  | { composant: "erreur"; message: string };
export type PageRendue = { blocs: BlocRendu[]; secours: boolean; vide: boolean; coupes: number };

class Illisible extends Error {}

const FORMAT = new Intl.NumberFormat("fr-FR");
const primitif = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function couper(s: string, max = TEXTE_MAX): string {
  if (s.length <= max) return s;
  let fin = max - 1;
  const c = s.charCodeAt(fin - 1);
  if (c >= 0xd800 && c <= 0xdbff) fin--; // ne pas couper une paire de substitution
  return s.slice(0, fin) + "…";
}

/** Une valeur des résultats en texte : nombres en fr-FR, listes de valeurs simples jointes, objets vides. */
function texte(v: unknown): string {
  if (typeof v === "string") return couper(v);
  if (typeof v === "number") return Number.isFinite(v) ? FORMAT.format(v) : "";
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (Array.isArray(v)) return couper(v.slice(0, ELEMENTS_MAX).filter(primitif).map(texte).filter(Boolean).join(", "));
  return "";
}

/** Toutes les chaînes des résultats (les valeurs, pas les clés), à toute profondeur. */
export function chainesDe(resultats: unknown): Set<string> {
  const chaines = new Set<string>();
  const pile: unknown[] = [resultats];
  while (pile.length > 0) {
    const v = pile.pop();
    if (typeof v === "string") chaines.add(v);
    else if (Array.isArray(v)) for (const e of v) pile.push(e);
    else if (v !== null && typeof v === "object") for (const k of Object.keys(v)) pile.push((v as Record<string, unknown>)[k]);
  }
  return chaines;
}

function sansResultat(r: unknown): boolean {
  const pile: unknown[] = [r];
  while (pile.length > 0) {
    const v = pile.pop();
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      return false;
    }
    if (typeof v === "object") {
      for (const k of Object.keys(v)) pile.push((v as Record<string, unknown>)[k]);
      continue;
    }
    return false;
  }
  return true;
}

/** Pose une propriété propre (une clé « __proto__ » reste une donnée, jamais un prototype). */
function poser(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

type Contexte = {
  resultats: unknown; compte: boolean; defs: Map<string, DefinitionComposant>; coupes: number; blocs: number;
  chaines: Set<string> | null;
};

const chaines = (ctx: Contexte) => (ctx.chaines ??= chainesDe(ctx.resultats));

function adressePermise(v: unknown, ctx: Contexte, httpsSeul: boolean): string | null {
  if (typeof v !== "string" || v.length > URL_MAX || !chaines(ctx).has(v)) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && (httpsSeul || u.protocol !== "http:")) return null;
  if (u.username || u.password || adresseLocale(u.hostname)) return null;
  return v;
}

function lienDe(v: unknown, libelle: string, ctx: Contexte): Lien {
  return { texte: libelle || texte(v), url: adressePermise(v, ctx, false) };
}

function imageDe(v: unknown, ctx: Contexte): Image {
  if (typeof v !== "string" || v === "") return null;
  if (ctx.compte) return { neutre: true };
  const url = adressePermise(v, ctx, true);
  return url === null ? null : { url };
}

// ---- Lecture défensive des propriétés d'un plan ----

function valeurDe(ref: unknown, ctx: Contexte): { valeur: unknown; groupee: boolean } {
  if (typeof ref !== "string") throw new Illisible();
  const r = lireReference(ref);
  if ("erreur" in r) throw new Illisible();
  const v = evaluer(r, ctx.resultats);
  if ("erreur" in v) throw new Illisible();
  return { valeur: v.valeur, groupee: r.ops.at(-1)?.op === "regrouper" };
}

function champDe(v: unknown): string {
  if (typeof v !== "string") throw new Illisible();
  const r = lireReference(v);
  if ("erreur" in r || r.ops.length > 0 || r.chemin === "$") throw new Illisible();
  return r.chemin;
}

const a = (props: Record<string, unknown>, k: string) => Object.hasOwn(props, k) && props[k] !== undefined && props[k] !== null;
const champOpt = (props: Record<string, unknown>, k: string) => (a(props, k) ? champDe(props[k]) : null);

function litteral(props: Record<string, unknown>, k: string, requis: true): string;
function litteral(props: Record<string, unknown>, k: string, requis?: false): string | null;
function litteral(props: Record<string, unknown>, k: string, requis = false): string | null {
  if (!a(props, k)) {
    if (requis) throw new Illisible();
    return null;
  }
  if (typeof props[k] !== "string") throw new Illisible();
  return couper(props[k] as string);
}

function objetDe(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Illisible();
  return v as Record<string, unknown>;
}

/** Une collection coupée à `ELEMENTS_MAX` éléments en tout (sections comprises) ; le reste est compté. */
function collection<T>(lue: { valeur: unknown; groupee: boolean }, ctx: Contexte, faire: (e: unknown) => T) {
  if (!Array.isArray(lue.valeur)) throw new Illisible();
  if (!lue.groupee) {
    const autres = Math.max(0, lue.valeur.length - ELEMENTS_MAX);
    ctx.coupes += autres;
    return { elements: lue.valeur.slice(0, ELEMENTS_MAX).map(faire), autres };
  }
  let reste = ELEMENTS_MAX;
  let autres = 0;
  const groupes: Groupe<T>[] = [];
  for (const g of lue.valeur as Groupe<unknown>[]) {
    const elements = Array.isArray(g?.elements) ? g.elements : [];
    const pris = elements.slice(0, reste);
    autres += elements.length - pris.length;
    reste -= pris.length;
    if (pris.length > 0) groupes.push({ valeur: texte(g.valeur), elements: pris.map(faire) });
  }
  ctx.coupes += autres;
  return { groupes, autres };
}

function etiquettesDe(v: unknown): string[] {
  if (Array.isArray(v)) return v.slice(0, ETIQUETTES_CARTE_MAX).filter(primitif).map(texte).filter(Boolean);
  const t = texte(v);
  return t ? [t] : [];
}

function colonnesDe(v: unknown): { champ: string; libelle: string }[] {
  if (!Array.isArray(v)) throw new Illisible();
  return v.map((c) => {
    const o = objetDe(c);
    const champ = champDe(o.champ);
    return { champ, libelle: typeof o.libelle === "string" ? couper(o.libelle) : champ };
  });
}

function textesDe(lue: unknown[], ctx: Contexte, lire: (e: unknown) => unknown) {
  const autres = Math.max(0, lue.length - ELEMENTS_MAX);
  ctx.coupes += autres;
  return { valeurs: lue.slice(0, ELEMENTS_MAX).map((e) => texte(lire(e))).filter(Boolean), autres };
}

function integre(nom: string, p: Record<string, unknown>, ctx: Contexte): Record<string, unknown> {
  switch (nom) {
    case "titre":
      return { texte: litteral(p, "texte", true) };
    case "paragraphe":
      return { texte: a(p, "valeur") ? texte(valeurDe(p.valeur, ctx).valeur) : litteral(p, "texte", true) };
    case "encadre": {
      let elements: string[] | null = null;
      let autres = 0;
      if (a(p, "elements")) {
        const l = valeurDe(p.elements, ctx).valeur;
        if (!Array.isArray(l)) throw new Illisible();
        const champ = champDe(p.champ);
        ({ valeurs: elements, autres } = textesDe(l, ctx, (e) => lireChemin(e, champ)));
      }
      const niveau = litteral(p, "niveau", true);
      if (!["info", "avis", "attention"].includes(niveau)) throw new Illisible();
      return { niveau, titre: litteral(p, "titre"), texte: litteral(p, "texte"), elements, autres };
    }
    case "chiffre":
      return { valeur: texte(valeurDe(p.valeur, ctx).valeur), libelle: litteral(p, "libelle", true) };
    case "chiffres": {
      if (!Array.isArray(p.chiffres)) throw new Illisible();
      return {
        chiffres: p.chiffres.slice(0, 6).map((c) => {
          const o = objetDe(c);
          return { valeur: texte(valeurDe(o.valeur, ctx).valeur), libelle: litteral(o, "libelle", true) };
        }),
      };
    }
    case "liste": {
      const titre = champDe(p.titre), sousTitre = champOpt(p, "sousTitre"), lien = champOpt(p, "lien");
      return collection(valeurDe(p.elements, ctx), ctx, (e) => {
        const t = texte(lireChemin(e, titre));
        return {
          titre: t,
          sousTitre: sousTitre === null ? null : texte(lireChemin(e, sousTitre)),
          lien: lien === null ? null : lienDe(lireChemin(e, lien), t, ctx),
        };
      });
    }
    case "cartes": {
      const titre = champDe(p.titre);
      const [sousTitre, image, valeur, etiquettes, lien] = ["sousTitre", "image", "valeur", "etiquettes", "lien"].map((k) => champOpt(p, k));
      const lire = (e: unknown, c: string | null | undefined) => (c ? lireChemin(e, c) : undefined);
      return collection(valeurDe(p.elements, ctx), ctx, (e) => {
        const t = texte(lireChemin(e, titre));
        return {
          titre: t,
          sousTitre: sousTitre ? texte(lire(e, sousTitre)) : null,
          image: image ? imageDe(lire(e, image), ctx) : null,
          valeur: valeur ? texte(lire(e, valeur)) : null,
          etiquettes: etiquettes ? etiquettesDe(lire(e, etiquettes)) : [],
          lien: lien ? lienDe(lire(e, lien), t, ctx) : null,
        };
      });
    }
    case "tableau": {
      const colonnes = colonnesDe(p.colonnes).slice(0, 8);
      const lien = champOpt(p, "lien");
      const r = collection(valeurDe(p.elements, ctx), ctx, (e) => {
        const valeurs: Record<string, string> = {};
        for (const c of colonnes) poser(valeurs, c.champ, texte(lireChemin(e, c.champ)));
        return { valeurs, lien: lien === null ? null : lienDe(lireChemin(e, lien), "", ctx) };
      });
      return { colonnes, ...r };
    }
    case "champs": {
      const objet = objetDe(valeurDe(p.objet, ctx).valeur);
      const champs = a(p, "champs")
        ? colonnesDe(p.champs).slice(0, 12).map((c) => ({ libelle: c.libelle, valeur: texte(lireChemin(objet, c.champ)) }))
        : Object.keys(objet).filter((k) => primitif(objet[k])).map((k) => ({ libelle: couper(k), valeur: texte(objet[k]) }));
      const autres = Math.max(0, champs.length - ELEMENTS_MAX);
      ctx.coupes += autres;
      return { champs: champs.slice(0, ELEMENTS_MAX), autres };
    }
    case "etiquettes": {
      if (a(p, "valeurs")) {
        const l = valeurDe(p.valeurs, ctx).valeur;
        if (!Array.isArray(l)) throw new Illisible();
        return textesDe(l.filter(primitif), ctx, (e) => e);
      }
      const l = valeurDe(p.elements, ctx).valeur;
      if (!Array.isArray(l)) throw new Illisible();
      const champ = champDe(p.champ);
      return textesDe(l, ctx, (e) => lireChemin(e, champ));
    }
    case "lien": {
      const objet = objetDe(valeurDe(p.objet, ctx).valeur);
      const url = lireChemin(objet, champDe(p.url));
      const libelle = a(p, "champTexte") ? texte(lireChemin(objet, champDe(p.champTexte))) : (litteral(p, "texte") ?? "");
      return { lien: lienDe(url, libelle, ctx) };
    }
    case "groupe":
      return { titre: litteral(p, "titre", true), replie: p.replie === true };
    case "colonnes":
      return {};
    default:
      throw new Illisible();
  }
}

/** La valeur d'une référence pour un composant de l'agent : propriétés propres, listes à 200, textes coupés, taille bornée. */
function borner(v: unknown, ctx: Contexte, budget: { noeuds: number }, prof = 0): unknown {
  if (--budget.noeuds < 0) return null;
  if (typeof v === "string") return couper(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null) return v;
  if (typeof v !== "object" || prof >= PROFONDEUR_AGENT) return null;
  if (Array.isArray(v)) {
    if (v.length > ELEMENTS_MAX) ctx.coupes += v.length - ELEMENTS_MAX;
    return v.slice(0, ELEMENTS_MAX).map((e) => borner(e, ctx, budget, prof + 1));
  }
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(v).slice(0, ELEMENTS_MAX)) poser(o, k, borner((v as Record<string, unknown>)[k], ctx, budget, prof + 1));
  return o;
}

function agent(def: DefinitionComposant, p: Record<string, unknown>, ctx: Contexte): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [nom, pr] of Object.entries(def.proprietes)) {
    if (!a(p, nom)) {
      if (pr.requis) throw new Illisible();
      continue;
    }
    const v = p[nom];
    switch (pr.genre) {
      case "reference": props[nom] = borner(valeurDe(v, ctx).valeur, ctx, { noeuds: NOEUDS_AGENT_MAX }); break;
      case "champ": props[nom] = champDe(v); break;
      case "texte": props[nom] = litteral(p, nom); break;
      case "nombre":
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Illisible();
        props[nom] = v;
        break;
      case "case":
        if (typeof v !== "boolean") throw new Illisible();
        props[nom] = v;
        break;
      default: throw new Illisible();
    }
  }
  return props;
}

function resoudreBlocs(blocs: unknown, niveau: number, ctx: Contexte): BlocRendu[] {
  if (!Array.isArray(blocs)) return [];
  const rendus: BlocRendu[] = [];
  for (const b of blocs as BlocPlan[]) {
    if (++ctx.blocs > MAX_BLOCS_PAGE) break;
    if (b === null || typeof b !== "object") continue;
    const nom = typeof b.composant === "string" ? b.composant.slice(0, 40) : "?";
    const def = ctx.defs.get(nom);
    if (!def) {
      rendus.push({ composant: "erreur", message: COMPOSANT_INDISPONIBLE(nom) });
      continue;
    }
    try {
      const p = b.props !== null && typeof b.props === "object" ? b.props : {};
      const rendu: BlocRendu = { composant: nom, props: def.origine === "agent" ? agent(def, p, ctx) : integre(nom, p, ctx) };
      if (def.origine === "integre" && niveau < PROFONDEUR_PAGE) {
        if (nom === "groupe") rendu.blocs = resoudreBlocs(b.blocs, niveau + 1, ctx);
        if (nom === "colonnes") {
          rendu.gauche = resoudreBlocs(b.gauche, niveau + 1, ctx);
          rendu.droite = resoudreBlocs(b.droite, niveau + 1, ctx);
        }
      }
      rendus.push(rendu);
    } catch (e) {
      if (!(e instanceof Illisible)) throw e;
      rendus.push({ composant: "erreur", message: BLOC_ILLISIBLE(nom) });
    }
  }
  return rendus;
}

export function resoudrePage(
  plan: PlanPage,
  resultats: unknown,
  o: { compte: boolean; catalogue: DefinitionComposant[]; secours: boolean },
): PageRendue {
  const ctx: Contexte = { resultats, compte: o.compte, defs: new Map(o.catalogue.map((d) => [d.nom, d])), coupes: 0, blocs: 0, chaines: null };
  const blocs = resoudreBlocs(plan?.blocs, 0, ctx);
  return { blocs, secours: o.secours, vide: sansResultat(resultats), coupes: ctx.coupes };
}
