import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "list.dedupe",
  label: "Dédoublonner",
  family: "Listes",
  description: "Retire les éléments qui ont la même valeur pour les clés données.",
  input: "required",
  fields: [
    { name: "keys", label: "Clés", help: "Chemins des valeurs qui identifient un élément.", required: true, default: ["url"], kind: "texts" },
  ],
  perItem: "no",
  chain: false,
  params: z
    .object({ keys: z.array(z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "chemin de clé invalide")).min(1).max(10) })
    .strict(),
};
