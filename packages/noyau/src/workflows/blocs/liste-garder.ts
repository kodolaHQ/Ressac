import { z } from "zod";
import type { DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "liste.garder",
  parElement: "non",
  parametres: z.object({ nombre: z.number().int().min(1).max(1000) }).strict(),
};
