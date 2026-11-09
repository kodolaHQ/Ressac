import { z } from "zod";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

/** Only for a widget that declares `"web": true` (validateWorkflow); the search is done by the kernel. */
export const definition: BlockDefinition = {
  type: "web.chercher",
  libelle: "Chercher sur le web",
  famille: "Sources",
  description: "Cherche sur DuckDuckGo et rend les résultats (titre, adresse, extrait).",
  entree: "parElement",
  champs: [
    { nom: "requete", libelle: "Recherche", aide: "Les {chemins} sont remplacés par les valeurs de l'élément.", requis: true, defaut: "{titre}", genre: "gabarit" },
    { nom: "nombre", libelle: "Nombre de résultats", requis: false, defaut: 8, genre: "nombre", min: 1, max: 20, entier: true },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
    { nom: "champ", libelle: "Champ des résultats", requis: false, defaut: "recherche", genre: "texte" },
  ],
  parElement: "option",
  chaine: true,
  parametres: z
    .object({
      requete: Template,
      nombre: z.number().int().min(1).max(20).default(8),
      ...ParamsPerElement,
      champ: z.string().min(1).max(40).default("recherche"),
    })
    .strict(),
};
