import { z } from "zod";
import { Gabarit, ParametresParElement, type DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "source.recuperer",
  parElement: "option",
  parametres: z
    .object({
      url: Gabarit,
      format: z.enum(["texte", "json"]).default("texte"),
      ...ParametresParElement,
      champ: z.string().min(1).max(40).default("contenu"),
    })
    .strict(),
};
