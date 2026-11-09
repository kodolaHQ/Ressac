import { z } from "zod";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "ia.rediger",
  libelle: "Rédiger avec Gemma",
  famille: "IA",
  description: "Fait écrire un texte à Gemma à partir d'une consigne.",
  entree: "parElement",
  champs: [
    { nom: "consigne", libelle: "Consigne", aide: "Les {chemins} sont remplacés par les valeurs de l'élément.", requis: true, defaut: "Résume : {texte}", genre: "gabarit" },
    { nom: "champ", libelle: "Champ de la réponse", requis: false, defaut: "texte", genre: "texte" },
    { nom: "json", libelle: "Réponse en JSON", requis: false, defaut: false, genre: "case" },
    { nom: "texteMax", libelle: "Taille maximale du texte", requis: false, defaut: 12_000, genre: "nombre", min: 1, max: 200_000, entier: true },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
  ],
  parElement: "option",
  chaine: true,
  parametres: z
    .object({
      consigne: Template,
      champ: z.string().min(1).max(40).default("texte"),
      json: z.boolean().default(false),
      texteMax: z.number().int().min(1).max(200_000).default(12_000),
      ...ParamsPerElement,
    })
    .strict(),
};
