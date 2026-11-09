import { z } from "zod";
import type { BlockDefinition } from "./common.js";

export const definition: BlockDefinition = {
  type: "liste.nouveaux",
  libelle: "Garder les nouveaux",
  famille: "Listes",
  description: "Ne garde que les éléments pas encore vus lors des exécutions précédentes.",
  entree: "requise",
  champs: [
    { nom: "cle", libelle: "Clé", aide: "Chemin de la valeur qui identifie un élément.", requis: true, defaut: "url", genre: "texte" },
    { nom: "garderJours", libelle: "Oublier après (jours)", aide: "Sans valeur : pour toujours.", requis: false, genre: "nombre", min: 1, max: 365, entier: true },
  ],
  parElement: "non",
  chaine: false,
  parametres: z
    .object({
      cle: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "chemin de clé invalide"),
      garderJours: z.number().int().min(1).max(365).optional(),
    })
    .strict(),
};
