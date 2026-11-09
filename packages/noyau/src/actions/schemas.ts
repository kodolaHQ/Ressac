import { z } from "zod";
import { SourcesDeclarees, verifierSources } from "../accueil/schemas.js";

export { WEB_AVEC_COMPTE } from "../accueil/schemas.js";

/** The name of an action's folder under `~/WebAiOs/actions/`. */
export const ID_ACTION = /^[a-z0-9-]{1,60}$/;

/** `action.json`: what the action is, what it reads and how Gemma should present it. Never written by WebAiOs. */
export const DeclarationAction = z
  .object({
    nom: z.string().min(1).max(60),
    description: z.string().max(200).default(""),
    motsCles: z.array(z.string().min(1).max(30)).max(10).default([]),
    /** The action asks for a text at launch (« clio lyon »): its label. */
    saisie: z.object({ libelle: z.string().min(1).max(40) }).strict().optional(),
    sources: SourcesDeclarees,
    /** Presentation instruction given to Gemma. */
    miseEnPage: z.string().min(1).max(1000).optional(),
    dureeMaxMinutes: z.number().int().min(1).max(60).optional(),
  })
  .strict()
  .superRefine((d, ctx) => verifierSources(d.sources, ctx));
export type DeclarationAction = z.infer<typeof DeclarationAction>;
