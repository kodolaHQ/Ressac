import { z } from "zod";
import { GENRES_SORTIE } from "../schema.js";
import type { DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "sortie",
  libelle: "Sortie vers le widget",
  famille: "Sortie",
  description: "Envoie le résultat au widget (ou ailleurs).",
  entree: "requise",
  champs: [
    { nom: "vers", libelle: "Destination", requis: false, defaut: "widget", genre: "choix", choix: [...GENRES_SORTIE] },
  ],
  parElement: "non",
  parametres: z
    .object({
      vers: z.enum(GENRES_SORTIE, { error: (i) => `vers inconnu : ${String(i.input)}` }).default("widget"),
    })
    .strict(),
};
