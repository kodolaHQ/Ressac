import { z } from "zod";
import { fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

// ia.trier always scores item by item: `parElement` is not a param.
const { perItem: _byElement, ...commonParams } = ParamsPerElement;

export const definition: BlockDefinition = {
  type: "ia.trier",
  label: "Trier avec Kev",
  family: "IA",
  description: "Note chaque élément avec Kev et garde ceux qui passent le seuil.",
  input: "requise",
  fields: [
    { name: "question", label: "Question", help: "Ce que Kev doit juger, par exemple « Est-ce intéressant ? ».", required: true, default: "Est-ce intéressant ?", kind: "gabarit" },
    { name: "texte", label: "Texte à juger", help: "Les {chemins} sont remplacés par les valeurs de l'élément.", required: true, default: "{titre}", kind: "gabarit" },
    { name: "seuil", label: "Seuil", required: false, default: 0.5, kind: "nombre", min: 0, max: 1 },
    { name: "champ", label: "Champ de la note", required: false, default: "p", kind: "texte" },
    // ia.trier always scores item by item: the common fields do not carry the « only per item » mark.
    ...fieldsPerElementOnly().map(({ perItemOnly: _mark, ...c }) => c),
  ],
  perItem: "toujours",
  chain: false,
  params: z
    .object({
      question: Template,
      text: Template,
      threshold: z.number().min(0).max(1).default(0.5),
      field: z.string().min(1).max(40).default("p"),
      ...commonParams,
    })
    .strict(),
};
