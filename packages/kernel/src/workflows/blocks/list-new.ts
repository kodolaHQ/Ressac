import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "list.new",
  label: "Garder les nouveaux",
  family: "Listes",
  description: "Ne garde que les éléments pas encore vus lors des exécutions précédentes.",
  input: "required",
  fields: [
    { name: "key", label: "Clé", help: "Chemin de la valeur qui identifie un élément.", required: true, default: "url", kind: "text" },
    { name: "keepDays", label: "Oublier après (jours)", help: "Sans valeur : pour toujours.", required: false, kind: "number", min: 1, max: 365, integer: true },
  ],
  perItem: "no",
  chain: false,
  params: z
    .object({
      key: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "chemin de clé invalide"),
      keepDays: z.number().int().min(1).max(365).optional(),
    })
    .strict(),
};
