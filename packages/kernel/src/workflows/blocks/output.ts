import { z } from "zod";
import { OUTPUT_KINDS } from "../schema.js";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "output",
  label: "Sortie vers le widget",
  family: "Sortie",
  description: "Envoie le résultat au widget (ou ailleurs).",
  input: "required",
  fields: [
    { name: "to", label: "Destination", required: false, default: "widget", kind: "choice", choices: [...OUTPUT_KINDS] },
    { name: "live", label: "Publier au fil de l'eau", help: "Chaque élément fini est montré sans attendre la fin de l'exécution.", required: false, kind: "checkbox" },
  ],
  perItem: "no",
  chain: false,
  params: z
    .object({
      to: z.enum(OUTPUT_KINDS, { error: (i) => `to inconnu : ${String(i.input)}` }).default("widget"),
      // Optional (absent = false), never `.default(false)` (nor a default value in the catalog: unchecked, the box removes the key): the validated params of an output of today, so the
      // `start` line sent to the container, do not change.
      live: z.boolean().optional(),
    })
    .strict(),
};
