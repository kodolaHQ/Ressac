import { z } from "zod";
import type { DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "liste.nouveaux",
  libelle: "Garder les nouveaux",
  famille: "Listes",
  description: "Ne garde que les éléments pas encore vus lors des exécutions précédentes.",
  entree: "requise",
  champs: [
    { nom: "cle", libelle: "Clé", aide: "Chemin de la valeur qui identifie un élément.", requis: true, defaut: "url", genre: "texte" },
  ],
  parElement: "non",
  parametres: z.object({ cle: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "chemin de clé invalide") }).strict(),
};
