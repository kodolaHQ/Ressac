import { z } from "zod";

/** Ce que le moteur sait d'un type de bloc : le schéma de ses paramètres et son rapport au mode « par élément ». */
export interface DefinitionBloc {
  type: string;
  parametres: z.ZodType;
  parElement: "non" | "option" | "toujours";
}

/** Paramètres communs aux blocs qui peuvent travailler élément par élément. */
export const ParametresParElement = {
  parElement: z.boolean().default(false),
  siErreur: z.enum(["sauter", "echouer"]).default("sauter"),
  budgetSecondes: z.number().int().min(1).max(170).optional(),
  reutiliser: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "chemin de clé invalide").optional(),
};

/** Texte d'un gabarit (`{chemin}`) : borné, jamais exécuté. */
export const Gabarit = z.string().min(1).max(20_000);
