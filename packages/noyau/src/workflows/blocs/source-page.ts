import { z } from "zod";
import { Gabarit, ParametresParElement, type DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "source.page",
  parElement: "option",
  parametres: z
    .object({
      url: Gabarit,
      compte: z.boolean().default(false),
      ...ParametresParElement,
      champ: z.string().min(1).max(40).default("page"),
    })
    .strict(),
};
