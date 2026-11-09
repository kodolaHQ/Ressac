import { z } from "zod";
import { FIELD_PER_ELEMENT, fieldsPerElementOnly, Template, ParamsPerElement, type BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "source.recuperer",
  libelle: "Récupérer une adresse",
  famille: "Sources",
  description: "Récupère le contenu d'une adresse, en texte ou en JSON.",
  entree: "parElement",
  champs: [
    { nom: "url", libelle: "Adresse", aide: "Les {chemins} sont remplacés par les valeurs de l'élément.", requis: true, genre: "gabarit" },
    { nom: "format", libelle: "Format", requis: false, defaut: "texte", genre: "choix", choix: ["texte", "json"] },
    FIELD_PER_ELEMENT,
    ...fieldsPerElementOnly(),
    { nom: "champ", libelle: "Champ du résultat", requis: false, defaut: "contenu", genre: "texte" },
  ],
  parElement: "option",
  chaine: true,
  parametres: z
    .object({
      url: Template,
      format: z.enum(["texte", "json"]).default("texte"),
      ...ParamsPerElement,
      champ: z.string().min(1).max(40).default("contenu"),
    })
    .strict(),
};
