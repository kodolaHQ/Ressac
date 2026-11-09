import { z } from "zod";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "ia.rediger",
  label: "Rédiger avec Gemma",
  family: "IA",
  description: "Fait écrire un texte à Gemma à partir d'une consigne.",
  input: "parElement",
  fields: [
    { name: "consigne", label: "Consigne", help: "Les {chemins} sont remplacés par les valeurs de l'élément.", required: true, default: "Résume : {texte}", kind: "gabarit" },
    { name: "champ", label: "Champ de la réponse", required: false, default: "texte", kind: "texte" },
    { name: "json", label: "Réponse en JSON", required: false, default: false, kind: "case" },
    { name: "texteMax", label: "Taille maximale du texte", required: false, default: 12_000, kind: "nombre", min: 1, max: 200_000, integer: true },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
  ],
  perItem: "option",
  chain: true,
  params: z
    .object({
      prompt: Template,
      field: z.string().min(1).max(40).default("texte"),
      json: z.boolean().default(false),
      maxText: z.number().int().min(1).max(200_000).default(12_000),
      ...ParamsPerElement,
    })
    .strict(),
};
