import { z } from "zod";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

/** Only for a widget that declares `"web": true` (validateWorkflow); the search is done by the kernel. */
export const definition: BlockDefinition = {
  type: "web.chercher",
  label: "Chercher sur le web",
  family: "Sources",
  description: "Cherche sur DuckDuckGo et rend les résultats (titre, adresse, extrait).",
  input: "parElement",
  fields: [
    { name: "requete", label: "Recherche", help: "Les {chemins} sont remplacés par les valeurs de l'élément.", required: true, default: "{titre}", kind: "gabarit" },
    { name: "nombre", label: "Nombre de résultats", required: false, default: 8, kind: "nombre", min: 1, max: 20, integer: true },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
    { name: "champ", label: "Champ des résultats", required: false, default: "recherche", kind: "texte" },
  ],
  perItem: "option",
  chain: true,
  params: z
    .object({
      query: Template,
      count: z.number().int().min(1).max(20).default(8),
      ...ParamsPerElement,
      field: z.string().min(1).max(40).default("recherche"),
    })
    .strict(),
};
