import { z } from "zod";

/** Where a workflow's output goes: the widget, or an action's page. */
export const OUTPUT_KINDS = ["widget", "page"] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/** Who owns a workflow: a widget or an action. */
export type Owner = { type: "widget"; id: string } | { type: "action"; id: string };

export const INVALID_WORKFLOW_PREFIX = "Workflow invalide : ";
export const WORKFLOW_MAX_SIZE = 256 * 1024;
export const MAX_BLOCKS = 100;
export const MAX_LIENS = 400;

const BLOCK_ID = /^[a-z0-9-]{1,40}$/;

export const Block = z
  .object({
    id: z.string().regex(BLOCK_ID, "id de bloc invalide (a-z, 0-9 et - , 40 caractères au plus)"),
    type: z.string().min(1).max(60),
    nom: z.string().max(60).optional(),
    position: z.object({ x: z.number(), y: z.number() }).strict().default({ x: 0, y: 0 }),
    parametres: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type Block = z.infer<typeof Block>;

export const Link = z.object({ de: z.string().min(1).max(40), vers: z.string().min(1).max(40) }).strict();
export type Link = z.infer<typeof Link>;

export const Workflow = z
  .object({
    version: z.literal(1),
    blocs: z.array(Block).max(MAX_BLOCKS),
    liens: z.array(Link).max(MAX_LIENS).default([]),
  })
  .strict();
export type Workflow = z.infer<typeof Workflow>;
