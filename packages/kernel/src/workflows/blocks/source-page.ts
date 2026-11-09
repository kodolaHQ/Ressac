import { z } from "zod";
import { SCROLL_MAX } from "../protocol.js";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "source.page",
  label: "Lire une page",
  family: "Sources",
  description: "Lit le texte d'une page web.",
  input: "perItem",
  fields: [
    { name: "url", label: "Adresse", help: "Les {chemins} sont remplacés par les valeurs de l'élément.", required: true, kind: "template" },
    { name: "account", label: "Avec mon compte", required: false, default: false, kind: "checkbox" },
    {
      name: "scroll",
      label: "Écrans à faire défiler",
      help: "Pour une page qui charge en défilant. Vide ou 0 : pas de défilement.",
      required: false,
      kind: "number",
      min: 0,
      max: SCROLL_MAX,
      integer: true,
    },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
    { name: "field", label: "Champ du résultat", required: false, default: "page", kind: "text" },
  ],
  perItem: "option",
  chain: true,
  params: z
    .object({
      url: Template,
      account: z.boolean().default(false),
      // Without a default: the hash of the params of an existing block (its memory) does not change.
      scroll: z.number().int().min(0).max(SCROLL_MAX).optional(),
      ...ParamsPerElement,
      field: z.string().min(1).max(40).default("page"),
    })
    .strict(),
};
