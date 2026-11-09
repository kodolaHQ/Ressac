import type { CatalogueBloc } from "@webaios/noyau";

export type ChampFormulaire = CatalogueBloc["champs"][number];

/**
 * Fields shown for these parameters: the « per item only » ones wait for `parElement` to be checked. A block that
 * always works item by item (`ia.trier`) has no such mark in the catalog: its fields are always there.
 */
export function champsAffiches(c: CatalogueBloc, parametres: Record<string, unknown>): ChampFormulaire[] {
  return c.champs.filter((f) => !f.parElementSeulement || parametres.parElement === true);
}

/** Value shown by the field: the block's, otherwise the catalog's default value. */
export function entreeDe(f: ChampFormulaire, parametres: Record<string, unknown>): unknown {
  return Object.hasOwn(parametres, f.nom) ? parametres[f.nom] : f.defaut;
}

/** Text of a value in a text, template, number or texts field (one line per value). */
export function texteDe(f: ChampFormulaire, v: unknown): string {
  if (v === undefined || v === null) return "";
  if (f.genre === "textes") return Array.isArray(v) ? v.map((x) => String(x)).join("\n") : String(v);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/**
 * The parameters with the field's new value (typed text, or a checkbox's boolean); null if the input means nothing
 * (unreadable number, or required number emptied). An emptied non-required field removes its key; a required text
 * stays empty (the validator will say so). An unchecked non-required checkbox without a default value (absent =
 * false) also removes its key.
 */
export function parametresAvec(parametres: Record<string, unknown>, f: ChampFormulaire, saisie: string | boolean): Record<string, unknown> | null {
  const { [f.nom]: _ancien, ...sans } = parametres;
  if (typeof saisie === "boolean") return !saisie && !f.requis && f.defaut === undefined ? sans : { ...parametres, [f.nom]: saisie };
  let v: unknown;
  if (f.genre === "nombre") {
    // Required, an emptied number changes nothing (the block keeps its value until a number is typed).
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
  // The order of the file's keys is kept.
  return { ...parametres, [f.nom]: v };
}
