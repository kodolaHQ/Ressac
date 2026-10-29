import type { CatalogueBloc } from "@webaios/noyau";

export type ChampFormulaire = CatalogueBloc["champs"][number];

/**
 * Champs montrés pour ces paramètres : ceux « seulement par élément » attendent que `parElement` soit coché. Un bloc qui
 * travaille toujours élément par élément (`ia.trier`) n'a pas la marque au catalogue : ses champs sont toujours là.
 */
export function champsAffiches(c: CatalogueBloc, parametres: Record<string, unknown>): ChampFormulaire[] {
  return c.champs.filter((f) => !f.parElementSeulement || parametres.parElement === true);
}

/** Valeur montrée par le champ : celle du bloc, sinon la valeur par défaut du catalogue. */
export function entreeDe(f: ChampFormulaire, parametres: Record<string, unknown>): unknown {
  return Object.hasOwn(parametres, f.nom) ? parametres[f.nom] : f.defaut;
}

/** Texte d'une valeur dans un champ texte, gabarit, nombre ou textes (une ligne par valeur). */
export function texteDe(f: ChampFormulaire, v: unknown): string {
  if (v === undefined || v === null) return "";
  if (f.genre === "textes") return Array.isArray(v) ? v.map((x) => String(x)).join("\n") : String(v);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/**
 * Les paramètres avec la nouvelle valeur du champ (texte saisi, ou booléen d'une case) ; null si la saisie ne veut rien
 * dire (nombre illisible, ou nombre requis vidé). Un champ vidé et non requis retire sa clé ; un texte requis reste vide
 * (le validateur le dira). Une case non requise sans valeur par défaut (absente = faux) décochée retire aussi sa clé.
 */
export function parametresAvec(parametres: Record<string, unknown>, f: ChampFormulaire, saisie: string | boolean): Record<string, unknown> | null {
  const { [f.nom]: _ancien, ...sans } = parametres;
  if (typeof saisie === "boolean") return !saisie && !f.requis && f.defaut === undefined ? sans : { ...parametres, [f.nom]: saisie };
  let v: unknown;
  if (f.genre === "nombre") {
    // Requis, un nombre vidé ne change rien (le bloc garde sa valeur tant qu'on ne tape pas un nombre).
    if (saisie.trim() === "") return f.requis ? null : sans;
    v = Number(saisie.trim().replace(",", "."));
    if (!Number.isFinite(v)) return null;
  } else if (f.genre === "textes") {
    const lignes = saisie.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (lignes.length === 0 && !f.requis) return sans;
    v = lignes;
  } else {
    if (saisie === "" && !f.requis) return sans;
    v = saisie;
  }
  // L'ordre des clés du fichier est gardé.
  return { ...parametres, [f.nom]: v };
}
