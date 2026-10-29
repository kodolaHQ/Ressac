import { z } from "zod";
import { CHAMP_PAR_ELEMENT, champsParElementSeulement, Gabarit, ParametresParElement, type DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "source.page",
  libelle: "Lire une page",
  famille: "Sources",
  description: "Lit le texte d'une page web.",
  entree: "parElement",
  champs: [
    { nom: "url", libelle: "Adresse", aide: "Les {chemins} sont remplacés par les valeurs de l'élément.", requis: true, genre: "gabarit" },
    { nom: "compte", libelle: "Avec mon compte", requis: false, defaut: false, genre: "case" },
    CHAMP_PAR_ELEMENT,
    ...champsParElementSeulement(),
    { nom: "champ", libelle: "Champ du résultat", requis: false, defaut: "page", genre: "texte" },
  ],
  parElement: "option",
  chaine: true,
  parametres: z
    .object({
      url: Gabarit,
      compte: z.boolean().default(false),
      ...ParametresParElement,
      champ: z.string().min(1).max(40).default("page"),
    })
    .strict(),
};
