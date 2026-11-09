import { BLOCK_REGISTRY } from "./blocks/index.js";
import type { FormField, BlockFamily } from "./blocks/common.js";

export type { FormField, BlockFamily } from "./blocks/common.js";

/** A block type as the interface shows it: serializable (no function or zod schema), cloneable through IPC. */
export type CatalogueBloc = {
  type: string;
  libelle: string;
  famille: BlockFamily;
  description: string;
  parElement: "non" | "option" | "toujours";
  entree: "requise" | "facultative" | "parElement";
  champs: FormField[];
};

const FAMILIES: BlockFamily[] = ["Sources", "Listes", "IA", "Logique/Code", "Sortie"];

/** The block types, grouped by family then in registry order. */
export function catalogueBlocs(): CatalogueBloc[] {
  const blocs = [...BLOCK_REGISTRY.values()].map((d) => ({
    type: d.type,
    libelle: d.libelle,
    famille: d.famille,
    description: d.description,
    parElement: d.parElement,
    entree: d.entree,
    champs: structuredClone(d.champs),
  }));
  return FAMILIES.flatMap((f) => blocs.filter((b) => b.famille === f));
}
