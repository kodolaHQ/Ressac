import { z } from "zod";

const urlWeb = z.string().refine((u) => {
  try {
    return ["http:", "https:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}, "URL http(s) attendue");

export const ConfigBloc = z.discriminatedUnion("type", [
  z.object({
    titre: z.string().min(1).max(80),
    type: z.literal("agent"),
    consigne: z.string().min(1),
    rafraichissement: z.object({ heures: z.number().positive() }).optional(),
  }),
  z.object({
    titre: z.string().min(1).max(80),
    type: z.literal("app"),
    url: urlWeb,
  }),
]);
export type ConfigBloc = z.infer<typeof ConfigBloc>;
export type ConfigBlocAgent = Extract<ConfigBloc, { type: "agent" }>;

export const EtatBloc = z.object({
  derniereMaj: z.string().nullable(),
  derniereTentative: z.string().nullable(),
  statut: z.enum(["ok", "en-cours", "erreur"]),
  erreur: z.string().optional(),
});
export type EtatBloc = z.infer<typeof EtatBloc>;

export const ETAT_PAR_DEFAUT: EtatBloc = { derniereMaj: null, derniereTentative: null, statut: "ok" };

export const Disposition = z.object({ ordre: z.array(z.string()) });
export type Disposition = z.infer<typeof Disposition>;

export type BlocLu =
  | { id: string; dossier: string; config: ConfigBloc; etat: EtatBloc; cheminHtml: string | null }
  | { id: string; dossier: string; erreur: string };

export interface EtatAccueil {
  ordre: string[];
  blocs: BlocLu[];
}
