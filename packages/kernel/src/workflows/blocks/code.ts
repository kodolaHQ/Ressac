import { z } from "zod";
import type { DefinitionBloc } from "./common.js";

export const definition: DefinitionBloc = {
  type: "code",
  libelle: "Code",
  famille: "Logique/Code",
  description: "Exécute un fichier .mjs du widget sur l'entrée reçue.",
  entree: "facultative",
  champs: [
    { nom: "source", libelle: "Fichier", aide: "Un fichier .mjs du dossier du widget.", requis: true, defaut: "code.mjs", genre: "texte" },
    { nom: "appel", libelle: "Appel", requis: false, defaut: "entree", genre: "choix", choix: ["entree", "recolte"] },
  ],
  parElement: "non",
  chaine: false,
  parametres: z
    .object({
      // A file name from the widget's folder, nothing else: no path, no « .. ».
      source: z.string().regex(/^[a-z0-9-]+\.mjs$/, "fichier .mjs du dossier du widget attendu"),
      appel: z.enum(["entree", "recolte"]).default("entree"),
    })
    .strict(),
};
