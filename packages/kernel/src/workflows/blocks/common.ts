import { z } from "zod";

/** What the engine knows about a block type: its params schema and its relation to the « per item » mode. */
export interface BlockDefinition {
  type: string;
  label: string;
  family: BlockFamily;
  description: string;
  params: z.ZodType;
  perItem: "no" | "option" | "always";
  /** `perItem`: required only when the `perItem` param is true. */
  input: "required" | "optional" | "perItem";
  /** The block's form fields: one per key of the params schema. */
  fields: FormField[];
  /**
   * The block can be part of the "as-it-goes" chain (when `perItem` is true): each item
   * goes through it alone up to the output. Internal to the engine, the catalog does not expose it.
   */
  chain: boolean;
}

export type BlockFamily = "Sources" | "Listes" | "IA" | "Logique/Code" | "Sortie";

export type FormField = {
  name: string;
  label: string;
  help?: string;
  required: boolean;
  /** Schema default value; for a required field, a neutral value that pre-fills a new block. */
  default?: unknown;
  kind: "text" | "template" | "number" | "checkbox" | "choice" | "texts";
  choices?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  /** Only when `perItem` is true (field, onError, budgetSeconds, reuse). */
  perItemOnly?: true;
};

/** Params common to the blocks that can work item by item. */
export const ParamsPerElement = {
  perItem: z.boolean().default(false),
  onError: z.enum(["skip", "fail"]).default("skip"),
  // 170 s at most without a maximum duration of the widget, its duration otherwise: the per-widget bound is in validateWorkflow.
  budgetSeconds: z.number().int().min(1).max(3600).optional(),
  reuse: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "chemin de clé invalide").optional(),
  /** Lifetime of a reused result; without a value, forever. Only with `reuse` (validateWorkflow). */
  keepDays: z.number().int().min(1).max(365).optional(),
};

/** Text of a template (`{chemin}`): bounded, never run. */
export const Template = z.string().min(1).max(20_000);

/** The `perItem` field and the fields that only make sense when it is true. */
export const FIELD_PER_ELEMENT: FormField = {
  name: "perItem",
  label: "Un élément à la fois",
  help: "Applique le bloc à chaque élément de la liste reçue.",
  required: false,
  default: false,
  kind: "checkbox",
};

export function fieldsPerElementOnly(): FormField[] {
  return [
    { name: "onError", label: "En cas d'erreur", required: false, default: "skip", kind: "choice", choices: ["skip", "fail"], perItemOnly: true },
    { name: "budgetSeconds", label: "Durée maximale (secondes)", help: "170 s au plus, ou la durée maximale de l'exécution", required: false, kind: "number", min: 1, max: 3600, integer: true, perItemOnly: true },
    { name: "reuse", label: "Réutiliser un résultat précédent", help: "Chemin de la clé qui identifie l'élément.", required: false, kind: "text", perItemOnly: true },
    { name: "keepDays", label: "Garder (jours)", help: "Sans valeur : pour toujours.", required: false, kind: "number", min: 1, max: 365, integer: true, perItemOnly: true },
  ];
}
