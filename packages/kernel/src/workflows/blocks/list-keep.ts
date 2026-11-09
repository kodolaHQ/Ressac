import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "liste.garder",
  label: "Garder les N premiers",
  family: "Listes",
  description: "Garde les premiers éléments de la liste.",
  input: "requise",
  fields: [
    { name: "nombre", label: "Nombre d'éléments", required: true, default: 10, kind: "nombre", min: 1, max: 1000, integer: true },
  ],
  perItem: "non",
  chain: false,
  params: z.object({ count: z.number().int().min(1).max(1000) }).strict(),
};
