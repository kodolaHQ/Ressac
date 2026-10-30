import { z } from "zod";
import { SourcesDeclarees, verifierSources } from "../accueil/schemas.js";

export { WEB_AVEC_COMPTE } from "../accueil/schemas.js";

/** Le nom du dossier d'une action sous `~/WebAiOs/actions/`. */
export const ID_ACTION = /^[a-z0-9-]{1,60}$/;

/** `action.json` : ce que l'action est, ce qu'elle lit et comment Gemma doit la présenter. Jamais écrit par WebAiOs. */
export const DeclarationAction = z
  .object({
    nom: z.string().min(1).max(60),
    description: z.string().max(200).default(""),
    motsCles: z.array(z.string().min(1).max(30)).max(10).default([]),
    /** L'action demande un texte au lancement (« clio lyon ») : son libellé. */
    saisie: z.object({ libelle: z.string().min(1).max(40) }).strict().optional(),
    sources: SourcesDeclarees,
    /** Consigne de présentation donnée à Gemma. */
    miseEnPage: z.string().min(1).max(1000).optional(),
    dureeMaxMinutes: z.number().int().min(1).max(60).optional(),
  })
  .strict()
  .superRefine((d, ctx) => verifierSources(d.sources, ctx));
export type DeclarationAction = z.infer<typeof DeclarationAction>;
