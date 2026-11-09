import { z } from "zod";

/** Where a workflow's output goes: the widget, or an action's page. */
export const GENRES_SORTIE = ["widget", "page"] as const;
export type GenreSortie = (typeof GENRES_SORTIE)[number];

/** Who owns a workflow: a widget or an action. */
export type Owner = { type: "widget"; id: string } | { type: "action"; id: string };

export const INVALID_WORKFLOW_PREFIX = "Workflow invalide : ";
export const TAILLE_MAX_WORKFLOW = 256 * 1024;
export const MAX_BLOCS = 100;
export const MAX_LIENS = 400;

const ID_BLOC = /^[a-z0-9-]{1,40}$/;

export const Bloc = z
  .object({
    id: z.string().regex(ID_BLOC, "id de bloc invalide (a-z, 0-9 et - , 40 caractères au plus)"),
    type: z.string().min(1).max(60),
    nom: z.string().max(60).optional(),
    position: z.object({ x: z.number(), y: z.number() }).strict().default({ x: 0, y: 0 }),
    parametres: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type Bloc = z.infer<typeof Bloc>;

export const Lien = z.object({ de: z.string().min(1).max(40), vers: z.string().min(1).max(40) }).strict();
export type Lien = z.infer<typeof Lien>;

export const Workflow = z
  .object({
    version: z.literal(1),
    blocs: z.array(Bloc).max(MAX_BLOCS),
    liens: z.array(Lien).max(MAX_LIENS).default([]),
  })
  .strict();
export type Workflow = z.infer<typeof Workflow>;
