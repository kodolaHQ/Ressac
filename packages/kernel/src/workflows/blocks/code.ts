import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "code",
  label: "Code",
  family: "Logique/Code",
  description: "Exécute un fichier .mjs du widget sur l'entrée reçue.",
  input: "facultative",
  fields: [
    { name: "source", label: "Fichier", help: "Un fichier .mjs du dossier du widget.", required: true, default: "code.mjs", kind: "texte" },
    { name: "appel", label: "Appel", required: false, default: "entree", kind: "choix", choices: ["entree", "recolte"] },
  ],
  perItem: "non",
  chain: false,
  params: z
    .object({
      // A file name from the widget's folder, nothing else: no path, no « .. ».
      source: z.string().regex(/^[a-z0-9-]+\.mjs$/, "fichier .mjs du dossier du widget attendu"),
      call: z.enum(["entree", "recolte"]).default("entree"),
    })
    .strict(),
};
