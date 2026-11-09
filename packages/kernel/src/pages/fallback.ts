import type { BlocPlan, PlanPage } from "./plan.js";

// The fallback layout, without Gemma: a simple presentation of the results, made of built-in components.
// It only references paths that exist and that the reference language can write; it passes validerPlan.

type Dict = Record<string, unknown>;
const isObject = (v: unknown): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);
const MOT = /^[\p{L}\p{N}_]+$/u;
const simple = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const IMAGE = /\.(?:jpe?g|png|webp|gif)(?:\?[^\s]*)?$/i;
const IMAGE_NAMES = ["image", "photo", "vignette"];
const LINK_NAMES = ["url", "lien", "href"];
const TITLE_NAMES = ["titre", "title", "nom", "name", "libelle", "label"];
const VALUE_NAMES = ["prix", "price", "valeur", "montant"];
const SAMPLE = 20;
const COLUMNS = 6;
const KEYS_MAX = 12;
const TITRE_MAX = 80;
const LABEL_MAX = 60;

const coupe = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
const bloc = (component: string, props: Record<string, unknown>): BlocPlan => ({ composant: component, props });
const keyValid = (k: string) => MOT.test(k);
const byName = (champs: string[], names: string[]) => champs.find((c) => names.includes(c.toLowerCase()));

/** The plain fields (text, number, boolean) of a list of objects, in order of appearance. */
function champsSimples(elements: Dict[]): { champ: string; urlImage: boolean; texte: boolean }[] {
  const vus = new Map<string, { urlImage: boolean; texte: boolean }>();
  for (const e of elements.slice(0, SAMPLE)) {
    for (const k of Object.keys(e)) {
      if (!keyValid(k) || !simple(e[k])) continue;
      const v = e[k];
      const f = vus.get(k) ?? { urlImage: false, texte: false };
      if (typeof v === "string") {
        f.texte = true;
        if (v.startsWith("https://") && IMAGE.test(v)) f.urlImage = true;
      }
      vus.set(k, f);
    }
  }
  return [...vus].map(([champ, f]) => ({ champ, ...f }));
}

/** The block of a list referenced by `ref`, or null if nothing readable. */
function listBlock(list: unknown[], ref: string): BlocPlan | null {
  if (list.length === 0) return null;
  const sample = list.slice(0, SAMPLE);
  if (sample.every(simple)) return bloc("etiquettes", { valeurs: ref });
  const objects = sample.filter(isObject);
  if (objects.length === 0) return null;
  const champs = champsSimples(objects);
  if (champs.length === 0) return null;
  const names = champs.map((c) => c.champ);
  const lien = byName(names, LINK_NAMES);
  const image = byName(names, IMAGE_NAMES) ?? champs.find((c) => c.urlImage)?.champ;
  if (image) {
    const texts = champs.filter((c) => c.texte && c.champ !== image && c.champ !== lien).map((c) => c.champ);
    const titre = byName(texts, TITLE_NAMES) ?? texts[0] ?? names.find((n) => n !== image) ?? image;
    const sousTitre = texts.find((c) => c !== titre);
    const valeur = byName(names, VALUE_NAMES);
    const props: Record<string, unknown> = { elements: ref, titre, image };
    if (sousTitre) props.sousTitre = sousTitre;
    if (valeur && valeur !== titre) props.valeur = valeur;
    if (lien) props.lien = lien;
    return bloc("cartes", props);
  }
  const props: Record<string, unknown> = {
    elements: ref,
    colonnes: names.slice(0, COLUMNS).map((champ) => ({ champ, libelle: coupe(champ, LABEL_MAX) })),
  };
  if (lien) props.lien = lien;
  return bloc("tableau", props);
}

function objectBlocks(o: Dict): BlocPlan[] {
  const blocs: BlocPlan[] = [bloc("titre", { texte: "Résultats" })];
  for (const key of Object.keys(o)) {
    if (blocs.length >= KEYS_MAX * 2) break;
    if (!keyValid(key)) continue;
    const v = o[key];
    if (typeof v === "number" && Number.isFinite(v)) blocs.push(bloc("chiffre", { valeur: key, libelle: coupe(key, LABEL_MAX) }));
    else if (typeof v === "string" && v !== "" || typeof v === "boolean") blocs.push(bloc("paragraphe", { valeur: key }));
    else if (Array.isArray(v)) {
      const b = listBlock(v, key);
      if (b) blocs.push(bloc("titre", { texte: coupe(key, TITRE_MAX) }), b);
    } else if (isObject(v)) {
      if (Object.keys(v).some((k) => keyValid(k) && simple(v[k]))) blocs.push(bloc("champs", { objet: key }));
    }
  }
  // Keys that a reference cannot write: their plain fields are read through the whole object.
  const reference = () => blocs.some((b) => b.composant !== "titre");
  if (Object.keys(o).some((k) => !keyValid(k) && simple(o[k]))) blocs.push(bloc("champs", { objet: "$" }));
  if (!reference()) blocs.push(LAST_RESORT);
  return blocs;
}

/** The last resort: all the results in a bounded text. Reference "$", so always valid. */
const LAST_RESORT = bloc("paragraphe", { valeur: "$" });
export const lastResortLayout = (): PlanPage => ({ blocs: [{ ...LAST_RESORT, props: { ...LAST_RESORT.props } }] });

export function fallbackLayout(results: unknown): PlanPage {
  if (Array.isArray(results)) {
    const b = listBlock(results, "$");
    return b ? { blocs: [b] } : lastResortLayout();
  }
  if (isObject(results)) return { blocs: objectBlocks(results) };
  if (typeof results === "number") return { blocs: [bloc("chiffre", { valeur: "$", libelle: "Résultat" })] };
  if (simple(results)) return { blocs: [bloc("paragraphe", { valeur: "$" })] };
  return lastResortLayout();
}
