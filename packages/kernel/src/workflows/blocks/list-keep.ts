import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "list.keep",
  label: "Garder les N premiers",
  family: "Listes",
  description: "Garde les premiers éléments de la liste.",
  input: "required",
  fields: [
    { name: "count", label: "Nombre d'éléments", required: true, default: 10, kind: "number", min: 1, max: 1000, integer: true },
  ],
  perItem: "no",
  chain: false,
  params: z.object({ count: z.number().int().min(1).max(1000) }).strict(),
};
