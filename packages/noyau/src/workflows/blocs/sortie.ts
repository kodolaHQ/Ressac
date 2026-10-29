import { z } from "zod";
import { GENRES_SORTIE } from "../schema.js";
import type { DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "sortie",
  parElement: "non",
  parametres: z
    .object({
      vers: z.enum(GENRES_SORTIE, { error: (i) => `vers inconnu : ${String(i.input)}` }).default("widget"),
    })
    .strict(),
};
