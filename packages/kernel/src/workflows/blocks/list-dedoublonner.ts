import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "liste.dedoublonner",
  libelle: "Dédoublonner",
  famille: "Listes",
  description: "Retire les éléments qui ont la même valeur pour les clés données.",
  entree: "requise",
  champs: [
    { nom: "cles", libelle: "Clés", aide: "Chemins des valeurs qui identifient un élément.", requis: true, defaut: ["url"], genre: "textes" },
  ],
  parElement: "non",
  chaine: false,
  parametres: z
    .object({ cles: z.array(z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "chemin de clé invalide")).min(1).max(10) })
    .strict(),
};
