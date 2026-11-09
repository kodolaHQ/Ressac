import { z } from "zod";
import { OUTPUT_KINDS } from "../schema.js";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "sortie",
  libelle: "Sortie vers le widget",
  famille: "Sortie",
  description: "Envoie le résultat au widget (ou ailleurs).",
  entree: "requise",
  champs: [
    { nom: "vers", libelle: "Destination", requis: false, defaut: "widget", genre: "choix", choix: [...OUTPUT_KINDS] },
    { nom: "auFilDeLEau", libelle: "Publier au fil de l'eau", aide: "Chaque élément fini est montré sans attendre la fin de l'exécution.", requis: false, genre: "case" },
  ],
  parElement: "non",
  chaine: false,
  parametres: z
    .object({
      vers: z.enum(OUTPUT_KINDS, { error: (i) => `vers inconnu : ${String(i.input)}` }).default("widget"),
      // Optional (absent = false), never `.default(false)` (nor a default value in the catalog: unchecked, the box removes the key): the validated params of an output of today, so the
      // `debut` line sent to the container, do not change.
      auFilDeLEau: z.boolean().optional(),
    })
    .strict(),
};
