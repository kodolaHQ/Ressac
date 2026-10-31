import type { BlocPlan, PlanPage } from "./plan.js";

// La mise en page de secours, sans Gemma : une présentation simple des résultats, faite de composants intégrés.
// Elle ne référence que des chemins qui existent et que le langage des références sait écrire ; elle passe validerPlan.

type Dict = Record<string, unknown>;
const estObjet = (v: unknown): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);
const MOT = /^[\p{L}\p{N}_]+$/u;
const simple = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const IMAGE = /\.(?:jpe?g|png|webp|gif)(?:\?[^\s]*)?$/i;
const NOMS_IMAGE = ["image", "photo", "vignette"];
const NOMS_LIEN = ["url", "lien", "href"];
const NOMS_TITRE = ["titre", "title", "nom", "name", "libelle", "label"];
const NOMS_VALEUR = ["prix", "price", "valeur", "montant"];
const ECHANTILLON = 20;
const COLONNES = 6;
const CLES_MAX = 12;
const TITRE_MAX = 80;
const LIBELLE_MAX = 60;

const coupe = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
const bloc = (composant: string, props: Record<string, unknown>): BlocPlan => ({ composant, props });
const cleValide = (k: string) => MOT.test(k);
const parNom = (champs: string[], noms: string[]) => champs.find((c) => noms.includes(c.toLowerCase()));

/** Les champs simples (texte, nombre, booléen) d'une liste d'objets, dans l'ordre d'apparition. */
function champsSimples(elements: Dict[]): { champ: string; urlImage: boolean; texte: boolean }[] {
  const vus = new Map<string, { urlImage: boolean; texte: boolean }>();
  for (const e of elements.slice(0, ECHANTILLON)) {
    for (const k of Object.keys(e)) {
      if (!cleValide(k) || !simple(e[k])) continue;
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

/** Le bloc d'une liste référencée par `ref`, ou null si rien de lisible. */
function blocListe(liste: unknown[], ref: string): BlocPlan | null {
  if (liste.length === 0) return null;
  const echantillon = liste.slice(0, ECHANTILLON);
  if (echantillon.every(simple)) return bloc("etiquettes", { valeurs: ref });
  const objets = echantillon.filter(estObjet);
  if (objets.length === 0) return null;
  const champs = champsSimples(objets);
  if (champs.length === 0) return null;
  const noms = champs.map((c) => c.champ);
  const lien = parNom(noms, NOMS_LIEN);
  const image = parNom(noms, NOMS_IMAGE) ?? champs.find((c) => c.urlImage)?.champ;
  if (image) {
    const textes = champs.filter((c) => c.texte && c.champ !== image && c.champ !== lien).map((c) => c.champ);
    const titre = parNom(textes, NOMS_TITRE) ?? textes[0] ?? noms.find((n) => n !== image) ?? image;
    const sousTitre = textes.find((c) => c !== titre);
    const valeur = parNom(noms, NOMS_VALEUR);
    const props: Record<string, unknown> = { elements: ref, titre, image };
    if (sousTitre) props.sousTitre = sousTitre;
    if (valeur && valeur !== titre) props.valeur = valeur;
    if (lien) props.lien = lien;
    return bloc("cartes", props);
  }
  const props: Record<string, unknown> = {
    elements: ref,
    colonnes: noms.slice(0, COLONNES).map((champ) => ({ champ, libelle: coupe(champ, LIBELLE_MAX) })),
  };
  if (lien) props.lien = lien;
  return bloc("tableau", props);
}

function blocsObjet(o: Dict): BlocPlan[] {
  const blocs: BlocPlan[] = [bloc("titre", { texte: "Résultats" })];
  for (const cle of Object.keys(o)) {
    if (blocs.length >= CLES_MAX * 2) break;
    if (!cleValide(cle)) continue;
    const v = o[cle];
    if (typeof v === "number" && Number.isFinite(v)) blocs.push(bloc("chiffre", { valeur: cle, libelle: coupe(cle, LIBELLE_MAX) }));
    else if (typeof v === "string" && v !== "" || typeof v === "boolean") blocs.push(bloc("paragraphe", { valeur: cle }));
    else if (Array.isArray(v)) {
      const b = blocListe(v, cle);
      if (b) blocs.push(bloc("titre", { texte: coupe(cle, TITRE_MAX) }), b);
    } else if (estObjet(v)) {
      if (Object.keys(v).some((k) => cleValide(k) && simple(v[k]))) blocs.push(bloc("champs", { objet: cle }));
    }
  }
  // Des clés qu'une référence ne sait pas écrire : leurs champs simples se lisent par l'objet entier.
  const reference = () => blocs.some((b) => b.composant !== "titre");
  if (Object.keys(o).some((k) => !cleValide(k) && simple(o[k]))) blocs.push(bloc("champs", { objet: "$" }));
  if (!reference()) blocs.push(DERNIER_RECOURS);
  return blocs;
}

/** Le dernier recours : tous les résultats en un texte borné. Référence "$", donc toujours valide. */
const DERNIER_RECOURS = bloc("paragraphe", { valeur: "$" });
export const miseEnPageDernierRecours = (): PlanPage => ({ blocs: [{ ...DERNIER_RECOURS, props: { ...DERNIER_RECOURS.props } }] });

export function miseEnPageSecours(resultats: unknown): PlanPage {
  if (Array.isArray(resultats)) {
    const b = blocListe(resultats, "$");
    return b ? { blocs: [b] } : miseEnPageDernierRecours();
  }
  if (estObjet(resultats)) return { blocs: blocsObjet(resultats) };
  if (typeof resultats === "number") return { blocs: [bloc("chiffre", { valeur: "$", libelle: "Résultat" })] };
  if (simple(resultats)) return { blocs: [bloc("paragraphe", { valeur: "$" })] };
  return miseEnPageDernierRecours();
}
