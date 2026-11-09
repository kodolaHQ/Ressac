import { z } from "zod";

/** What the engine knows about a block type: its params schema and its relation to the « per item » mode. */
export interface BlockDefinition {
  type: string;
  libelle: string;
  famille: BlockFamily;
  description: string;
  parametres: z.ZodType;
  parElement: "non" | "option" | "toujours";
  /** `parElement`: required only when the `parElement` param is true. */
  entree: "requise" | "facultative" | "parElement";
  /** The block's form fields: one per key of the params schema. */
  champs: FormField[];
  /**
   * The block can be part of the "as-it-goes" chain (when `parElement` is true): each item
   * goes through it alone up to the output. Internal to the engine, the catalog does not expose it.
   */
  chaine: boolean;
}

export type BlockFamily = "Sources" | "Listes" | "IA" | "Logique/Code" | "Sortie";

export type FormField = {
  nom: string;
  libelle: string;
  aide?: string;
  requis: boolean;
  /** Schema default value; for a required field, a neutral value that pre-fills a new block. */
  defaut?: unknown;
  genre: "texte" | "gabarit" | "nombre" | "case" | "choix" | "textes";
  choix?: string[];
  min?: number;
  max?: number;
  entier?: boolean;
  /** Only when `parElement` is true (champ, siErreur, budgetSecondes, reutiliser). */
  parElementSeulement?: true;
};

/** Params common to the blocks that can work item by item. */
export const ParamsPerElement = {
  parElement: z.boolean().default(false),
  siErreur: z.enum(["sauter", "echouer"]).default("sauter"),
  // 170 s at most without a maximum duration of the widget, its duration otherwise: the per-widget bound is in validerWorkflow.
  budgetSecondes: z.number().int().min(1).max(3600).optional(),
  reutiliser: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "chemin de clé invalide").optional(),
  /** Lifetime of a reused result; without a value, forever. Only with `reutiliser` (validerWorkflow). */
  garderJours: z.number().int().min(1).max(365).optional(),
};

/** Text of a template (`{chemin}`): bounded, never run. */
export const Template = z.string().min(1).max(20_000);

/** The `parElement` field and the fields that only make sense when it is true. */
export const FIELD_PER_ELEMENT: FormField = {
  nom: "parElement",
  libelle: "Un élément à la fois",
  aide: "Applique le bloc à chaque élément de la liste reçue.",
  requis: false,
  defaut: false,
  genre: "case",
};

export function fieldsPerElementOnly(): FormField[] {
  return [
    { nom: "siErreur", libelle: "En cas d'erreur", requis: false, defaut: "sauter", genre: "choix", choix: ["sauter", "echouer"], parElementSeulement: true },
    { nom: "budgetSecondes", libelle: "Durée maximale (secondes)", aide: "170 s au plus, ou la durée maximale de l'exécution", requis: false, genre: "nombre", min: 1, max: 3600, entier: true, parElementSeulement: true },
    { nom: "reutiliser", libelle: "Réutiliser un résultat précédent", aide: "Chemin de la clé qui identifie l'élément.", requis: false, genre: "texte", parElementSeulement: true },
    { nom: "garderJours", libelle: "Garder (jours)", aide: "Sans valeur : pour toujours.", requis: false, genre: "nombre", min: 1, max: 365, entier: true, parElementSeulement: true },
  ];
}
