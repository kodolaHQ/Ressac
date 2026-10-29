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
    { nom: "auFilDeLEau", libelle: "Publier au fil de l'eau", aide: "Chaque élément fini est montré sans attendre la fin de l'exécution.", requis: false, genre: "case" },
  ],
  parElement: "non",
  chaine: false,
  parametres: z
    .object({
      vers: z.enum(GENRES_SORTIE, { error: (i) => `vers inconnu : ${String(i.input)}` }).default("widget"),
      // Facultatif (absent = faux), jamais `.default(false)` (ni valeur par défaut au catalogue : décochée, la case retire la clé) : les paramètres validés d'une sortie d'aujourd'hui, donc la
      // ligne `debut` envoyée au conteneur, ne changent pas.
      auFilDeLEau: z.boolean().optional(),
    })
    .strict(),
};
