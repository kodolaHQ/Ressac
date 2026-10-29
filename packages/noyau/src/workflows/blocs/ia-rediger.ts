import { z } from "zod";
import { Gabarit, ParametresParElement, type DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "ia.rediger",
  parElement: "option",
  parametres: z
    .object({
      consigne: Gabarit,
      champ: z.string().min(1).max(40).default("texte"),
      json: z.boolean().default(false),
      texteMax: z.number().int().min(1).max(200_000).default(12_000),
      ...ParametresParElement,
    })
    .strict(),
};
