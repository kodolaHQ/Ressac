import { z } from "zod";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "ai.write",
  label: "Rédiger avec Gemma",
  family: "IA",
  description: "Fait écrire un texte à Gemma à partir d'une consigne.",
  input: "perItem",
  fields: [
    { name: "prompt", label: "Consigne", help: "Les {chemins} sont remplacés par les valeurs de l'élément.", required: true, default: "Résume : {text}", kind: "template" },
    { name: "field", label: "Champ de la réponse", required: false, default: "text", kind: "text" },
    { name: "json", label: "Réponse en JSON", required: false, default: false, kind: "checkbox" },
    { name: "maxText", label: "Taille maximale du texte", required: false, default: 12_000, kind: "number", min: 1, max: 200_000, integer: true },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
  ],
  perItem: "option",
  chain: true,
  params: z
    .object({
      prompt: Template,
      field: z.string().min(1).max(40).default("text"),
      json: z.boolean().default(false),
      maxText: z.number().int().min(1).max(200_000).default(12_000),
      ...ParamsPerElement,
    })
    .strict(),
};
