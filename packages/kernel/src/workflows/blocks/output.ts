import { z } from "zod";
import { OUTPUT_KINDS } from "../schema.js";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "sortie",
  label: "Sortie vers le widget",
  family: "Sortie",
  description: "Envoie le résultat au widget (ou ailleurs).",
  input: "requise",
  fields: [
    { name: "vers", label: "Destination", required: false, default: "widget", kind: "choix", choices: [...OUTPUT_KINDS] },
    { name: "auFilDeLEau", label: "Publier au fil de l'eau", help: "Chaque élément fini est montré sans attendre la fin de l'exécution.", required: false, kind: "case" },
  ],
  perItem: "non",
  chain: false,
  params: z
    .object({
      to: z.enum(OUTPUT_KINDS, { error: (i) => `vers inconnu : ${String(i.input)}` }).default("widget"),
      // Optional (absent = false), never `.default(false)` (nor a default value in the catalog: unchecked, the box removes the key): the validated params of an output of today, so the
      // `debut` line sent to the container, do not change.
      live: z.boolean().optional(),
    })
    .strict(),
};
