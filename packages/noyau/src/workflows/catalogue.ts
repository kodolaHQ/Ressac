import { REGISTRE_BLOCS } from "./blocs/index.js";
import type { ChampFormulaire, FamilleBloc } from "./blocs/communs.js";

export type { ChampFormulaire, FamilleBloc } from "./blocs/communs.js";

/** Un type de bloc tel que l'interface le montre : sérialisable (ni fonction ni schéma zod), clonable par IPC. */
export type CatalogueBloc = {
  type: string;
  libelle: string;
  famille: FamilleBloc;
  description: string;
  parElement: "non" | "option" | "toujours";
  entree: "requise" | "facultative" | "parElement";
  champs: ChampFormulaire[];
};

const FAMILLES: FamilleBloc[] = ["Sources", "Listes", "IA", "Logique/Code", "Sortie"];

/** Les types de blocs, rangés par famille puis dans l'ordre du registre. */
export function catalogueBlocs(): CatalogueBloc[] {
  const blocs = [...REGISTRE_BLOCS.values()].map((d) => ({
    type: d.type,
    libelle: d.libelle,
    famille: d.famille,
    description: d.description,
    parElement: d.parElement,
    entree: d.entree,
    champs: structuredClone(d.champs),
  }));
  return FAMILLES.flatMap((f) => blocs.filter((b) => b.famille === f));
}
