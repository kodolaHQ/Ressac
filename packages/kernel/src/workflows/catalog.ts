import { say } from "../i18n.js";
import { BLOCK_REGISTRY } from "./blocks/index.js";
import type { BlockDefinition, FormField, BlockFamily } from "./blocks/common.js";

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

/** The block types, grouped by family then in registry order; texts in the language of `locale` (definitions hold message ids). */
export function blockCatalog(locale = "en"): BlockCatalogEntry[] {
  const fields = (d: BlockDefinition) =>
    structuredClone(d.fields).map((f) => ({ ...f, label: say(locale, f.label), ...(f.help === undefined ? {} : { help: say(locale, f.help) }) }));
  const blocks = [...BLOCK_REGISTRY.values()].map((d) => ({
    type: d.type,
    label: say(locale, d.label),
    family: d.family,
    description: say(locale, d.description),
    perItem: d.perItem,
    input: d.input,
    fields: fields(d),
  }));
  return FAMILIES.flatMap((f) => blocks.filter((b) => b.family === f));
}
