import { z } from "zod";
import type { DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "source.flux",
  parElement: "non",
  parametres: z
    .object({
      urls: z.array(z.string().min(1).max(2000)).min(1).max(20),
      siErreur: z.enum(["sauter", "echouer"]).default("sauter"),
    })
    .strict(),
};
