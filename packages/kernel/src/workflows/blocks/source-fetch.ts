import { z } from "zod";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "source.fetch",
  label: "Récupérer une adresse",
  family: "Sources",
  description: "Récupère le contenu d'une adresse, en texte ou en JSON.",
  input: "perItem",
  fields: [
    { name: "url", label: "Adresse", help: "Les {chemins} sont remplacés par les valeurs de l'élément.", required: true, kind: "template" },
    { name: "format", label: "Format", required: false, default: "text", kind: "choice", choices: ["text", "json"] },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
    { name: "field", label: "Champ du résultat", required: false, default: "content", kind: "text" },
  ],
  perItem: "option",
  chain: true,
  params: z
    .object({
      url: Template,
      format: z.enum(["text", "json"]).default("text"),
      ...ParamsPerElement,
      field: z.string().min(1).max(40).default("content"),
    })
    .strict(),
};
