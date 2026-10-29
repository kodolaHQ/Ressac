import { z } from "zod";
import type { DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "source.flux",
  libelle: "Lire des flux RSS",
  famille: "Sources",
  description: "Lit des flux RSS ou Atom et donne leurs articles.",
  entree: "facultative",
  champs: [
    { nom: "urls", libelle: "Adresses des flux", requis: true, genre: "textes" },
    { nom: "siErreur", libelle: "En cas d'erreur", requis: false, defaut: "sauter", genre: "choix", choix: ["sauter", "echouer"] },
  ],
  parElement: "non",
  parametres: z
    .object({
      urls: z.array(z.string().min(1).max(2000)).min(1).max(20),
      siErreur: z.enum(["sauter", "echouer"]).default("sauter"),
    })
    .strict(),
};
