import { z } from "zod";
import type { DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "liste.dedoublonner",
  parElement: "non",
  parametres: z
    .object({ cles: z.array(z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "chemin de clé invalide")).min(1).max(10) })
    .strict(),
};
