import { z } from "zod";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

/** Only for a widget that declares `"web": true` (validateWorkflow); the search is done by the kernel. */
export const definition: BlockDefinition = {
  type: "web.search",
  label: "Chercher sur le web",
  family: "Sources",
  description: "Cherche sur DuckDuckGo et rend les résultats (titre, adresse, extrait).",
  input: "perItem",
  fields: [
    { name: "query", label: "Recherche", help: "Les {chemins} sont remplacés par les valeurs de l'élément.", required: true, default: "{title}", kind: "template" },
    { name: "count", label: "Nombre de résultats", required: false, default: 8, kind: "number", min: 1, max: 20, integer: true },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
    { name: "field", label: "Champ des résultats", required: false, default: "search", kind: "text" },
  ],
  perItem: "option",
  chain: true,
  params: z
    .object({
      query: Template,
      count: z.number().int().min(1).max(20).default(8),
      ...ParamsPerElement,
      field: z.string().min(1).max(40).default("search"),
    })
    .strict(),
};
