import { z } from "zod";
import { Gabarit, ParametresParElement, type DefinitionBloc } from "./communs.js";

// ia.trier note toujours élément par élément : `parElement` n'est pas un paramètre.
const { parElement: _parElement, ...parametresCommuns } = ParametresParElement;

export const definition: DefinitionBloc = {
  type: "ia.trier",
  parElement: "toujours",
  parametres: z
    .object({
      question: Gabarit,
      texte: Gabarit,
      seuil: z.number().min(0).max(1).default(0.5),
      champ: z.string().min(1).max(40).default("p"),
      ...parametresCommuns,
    })
    .strict(),
};
