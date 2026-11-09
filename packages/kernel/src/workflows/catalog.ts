import { BLOCK_REGISTRY } from "./blocks/index.js";
import type { FormField, BlockFamily } from "./blocks/common.js";

export type { FormField, BlockFamily } from "./blocks/common.js";

/** A block type as the interface shows it: serializable (no function or zod schema), cloneable through IPC. */
export type BlockCatalogEntry = {
  type: string;
  label: string;
  family: BlockFamily;
  description: string;
  perItem: "no" | "option" | "always";
  input: "required" | "optional" | "perItem";
  fields: FormField[];
};

const FAMILIES: BlockFamily[] = ["Sources", "Listes", "IA", "Logique/Code", "Sortie"];

/** The block types, grouped by family then in registry order. */
export function blockCatalog(): BlockCatalogEntry[] {
  const blocks = [...BLOCK_REGISTRY.values()].map((d) => ({
    type: d.type,
    label: d.label,
    family: d.family,
    description: d.description,
    perItem: d.perItem,
    input: d.input,
    fields: structuredClone(d.fields),
  }));
  return FAMILIES.flatMap((f) => blocks.filter((b) => b.family === f));
}
