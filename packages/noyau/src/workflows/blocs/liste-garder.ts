import { z } from "zod";
import type { DefinitionBloc } from "./communs.js";

export const definition: DefinitionBloc = {
  type: "liste.garder",
  libelle: "Garder les N premiers",
  famille: "Listes",
  description: "Garde les premiers éléments de la liste.",
  entree: "requise",
  champs: [
    { nom: "nombre", libelle: "Nombre d'éléments", requis: true, defaut: 10, genre: "nombre", min: 1, max: 1000, entier: true },
  ],
  parElement: "non",
  parametres: z.object({ nombre: z.number().int().min(1).max(1000) }).strict(),
};
