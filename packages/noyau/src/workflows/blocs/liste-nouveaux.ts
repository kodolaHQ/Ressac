import { z } from "zod";
import type { DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "liste.nouveaux",
  parElement: "non",
  parametres: z.object({ cle: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "chemin de clé invalide") }).strict(),
};
