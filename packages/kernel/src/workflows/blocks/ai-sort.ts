import { z } from "zod";
import { fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

// ai.sort always scores item by item: `perItem` is not a param.
const { perItem: _byElement, ...commonParams } = ParamsPerElement;

export const definition: BlockDefinition = {
  type: "ai.sort",
  label: "Trier avec Kev",
  family: "IA",
  description: "Note chaque élément avec Kev et garde ceux qui passent le seuil.",
  input: "required",
  fields: [
    { name: "question", label: "Question", help: "Ce que Kev doit juger, par exemple « Est-ce intéressant ? ».", required: true, default: "Est-ce intéressant ?", kind: "template" },
    { name: "text", label: "Texte à juger", help: "Les {chemins} sont remplacés par les valeurs de l'élément.", required: true, default: "{title}", kind: "template" },
    { name: "threshold", label: "Seuil", required: false, default: 0.5, kind: "number", min: 0, max: 1 },
    { name: "field", label: "Champ de la note", required: false, default: "score", kind: "text" },
    // ai.sort always scores item by item: the common fields do not carry the « only per item » mark.
    ...fieldsPerElementOnly().map(({ perItemOnly: _mark, ...c }) => c),
  ],
  perItem: "always",
  chain: false,
  params: z
    .object({
      question: Template,
      text: Template,
      threshold: z.number().min(0).max(1).default(0.5),
      field: z.string().min(1).max(40).default("score"),
      ...commonParams,
    })
    .strict(),
};
