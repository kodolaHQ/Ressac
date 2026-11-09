import { z } from "zod";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "source.recuperer",
  label: "Récupérer une adresse",
  family: "Sources",
  description: "Récupère le contenu d'une adresse, en texte ou en JSON.",
  input: "parElement",
  fields: [
    { name: "url", label: "Adresse", help: "Les {chemins} sont remplacés par les valeurs de l'élément.", required: true, kind: "gabarit" },
    { name: "format", label: "Format", required: false, default: "texte", kind: "choix", choices: ["texte", "json"] },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
    { name: "champ", label: "Champ du résultat", required: false, default: "contenu", kind: "texte" },
  ],
  perItem: "option",
  chain: true,
  params: z
    .object({
      url: Template,
      format: z.enum(["texte", "json"]).default("texte"),
      ...ParamsPerElement,
      field: z.string().min(1).max(40).default("contenu"),
    })
    .strict(),
};
