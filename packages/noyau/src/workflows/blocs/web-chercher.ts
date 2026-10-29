import { z } from "zod";
import { CHAMP_PAR_ELEMENT, champsParElementSeulement, Gabarit, ParametresParElement, type DefinitionBloc } from "./communs.js";

/** Seulement pour un widget qui déclare `"web": true` (validerWorkflow) ; la recherche est faite par le noyau. */
export const definition: DefinitionBloc = {
  type: "web.chercher",
  libelle: "Chercher sur le web",
  famille: "Sources",
  description: "Cherche sur DuckDuckGo et rend les résultats (titre, adresse, extrait).",
  entree: "parElement",
  champs: [
    { nom: "requete", libelle: "Recherche", aide: "Les {chemins} sont remplacés par les valeurs de l'élément.", requis: true, defaut: "{titre}", genre: "gabarit" },
    { nom: "nombre", libelle: "Nombre de résultats", requis: false, defaut: 8, genre: "nombre", min: 1, max: 20, entier: true },
    CHAMP_PAR_ELEMENT,
    ...champsParElementSeulement(),
    { nom: "champ", libelle: "Champ des résultats", requis: false, defaut: "recherche", genre: "texte" },
  ],
  parElement: "option",
  chaine: true,
  parametres: z
    .object({
      requete: Gabarit,
      nombre: z.number().int().min(1).max(20).default(8),
      ...ParametresParElement,
      champ: z.string().min(1).max(40).default("recherche"),
    })
    .strict(),
};
