import { z } from "zod";
import type { DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "code",
  parElement: "non",
  parametres: z
    .object({
      // Un nom de fichier du dossier du widget, rien d'autre : ni chemin, ni « .. ».
      source: z.string().regex(/^[a-z0-9-]+\.mjs$/, "fichier .mjs du dossier du widget attendu"),
      appel: z.enum(["entree", "recolte"]).default("entree"),
    })
    .strict(),
};
