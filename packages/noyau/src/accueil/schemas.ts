import { z } from "zod";

export const COLONNES = 12;
export { TAILLE_MAX_DONNEES } from "../workflows/protocole.js";

/** Nom d'hôte en minuscules (« news.ycombinator.com »). */
const domaine = z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, "nom d'hôte en minuscules attendu");
const cote = z.number().int().min(1).max(12);
const taille = z.object({ l: cote, h: cote });

export const WEB_AVEC_COMPTE = "web : impossible avec un compte (les données d'un compte ne doivent pas pouvoir partir vers un site inconnu)";

/** Ce qu'un propriétaire (widget ou action) lit : domaines avec son compte, domaines publics, recherche web. */
export const SourcesDeclarees = z
  .object({ compte: z.array(domaine).default([]), publiques: z.array(domaine).default([]), web: z.boolean().default(false) })
  .default({ compte: [], publiques: [], web: false });
export type SourcesDeclarees = z.infer<typeof SourcesDeclarees>;

/** Refuse `web` avec un `compte` (les données d'un compte ne doivent pas pouvoir partir vers un site inconnu). */
export function verifierSources(s: SourcesDeclarees, ctx: z.RefinementCtx): void {
  if (s.web && s.compte.length > 0) {
    ctx.addIssue({ code: "custom", path: ["sources", "web"], message: WEB_AVEC_COMPTE });
  }
}

const heureFixe = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "heure HH:MM attendue");

const Recolte = z
  .object({
    minutes: z.number().int().min(5).max(10080).optional(),
    heures: z.array(heureFixe).min(1).max(6).optional(),
    dureeMaxMinutes: z.number().int().min(1).max(60).optional(),
    notifier: z.boolean().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.minutes === undefined && r.heures === undefined) {
      ctx.addIssue({ code: "custom", message: "minutes ou heures attendu" });
    }
    if (r.heures && new Set(r.heures).size !== r.heures.length) {
      ctx.addIssue({ code: "custom", path: ["heures"], message: "heures en double" });
    }
  });

export const DeclarationWidget = z
  .object({
    nom: z.string().min(1).max(60),
    description: z.string().default(""),
    tailles: z.object({ min: taille, max: taille, defaut: taille }),
    recolte: Recolte.optional(),
    // Pour un widget avec `compte`, `publiques` vide = aucune récupération publique permise (liste appliquée par la tâche 5).
    sources: SourcesDeclarees,
    config: z.unknown().optional(),
  })
  .superRefine((d, ctx) => {
    verifierSources(d.sources, ctx);
    const { min, max, defaut } = d.tailles;
    for (const axe of ["l", "h"] as const) {
      if (!(min[axe] <= defaut[axe] && defaut[axe] <= max[axe])) {
        ctx.addIssue({ code: "custom", path: ["tailles"], message: `min ≤ defaut ≤ max exigé (${axe})` });
      }
    }
  });
export type DeclarationWidget = z.infer<typeof DeclarationWidget>;

export const Placement = z
  .object({ id: z.string(), x: z.number().int().min(0), y: z.number().int().min(0), l: cote, h: cote })
  .refine((p) => p.x + p.l <= COLONNES, "déborde de la grille");
export type Placement = z.infer<typeof Placement>;

export const Disposition = z.object({ version: z.literal(2), widgets: z.array(Placement) });
export type Disposition = z.infer<typeof Disposition>;

/** Millièmes de la largeur de l'accueil : la grille de 12 colonnes y perd sa précision. */
export const LARGEUR_LIBRE = 1000;
/** One height unit, in pixels. */
export const RANGEE_PX = 90;

export const PlacementLibre = z
  .object({ id: z.string(), x: z.number().int().min(0).max(LARGEUR_LIBRE), y: z.number().int().min(0), l: z.number().int().min(1).max(LARGEUR_LIBRE), h: z.number().int().min(1) })
  .refine((p) => p.x + p.l <= LARGEUR_LIBRE, "déborde de l'accueil");
export type PlacementLibre = z.infer<typeof PlacementLibre>;

export const DispositionLibre = z.object({ version: z.literal(3), widgets: z.array(PlacementLibre) });
export type DispositionLibre = z.infer<typeof DispositionLibre>;

/** Convertit une taille déclarée en unités (1…12) vers les unités libres. */
export function taillesLibres(t: { l: number; h: number }): { l: number; h: number } {
  return { l: Math.round((t.l * LARGEUR_LIBRE) / COLONNES), h: t.h * RANGEE_PX };
}

const StatutWidget = z.enum(["ok", "en-cours", "erreur", "accord-requis", "atelier-arrete"]);

export const EtatWidget = z.object({
  statut: StatutWidget,
  derniereMaj: z.string().nullable(),
  derniereTentative: z.string().nullable(),
  erreur: z.string().optional(),
  /**
   * L'erreur a été écrite par le noyau, sans texte venu du widget (son message d'échec, sa sortie…). Absente : elle a
   * pu l'être par le widget, qui peut y mettre des données du compte de l'utilisateur.
   */
  erreurNoyau: z.literal(true).optional(),
  journal: z.string().optional(),
  /** Exécution en cours : éléments faits sur le total. */
  progression: z.object({ faits: z.number().int().min(0), total: z.number().int().min(0) }).optional(),
  /** Suivi des heures fixes : créneaux « YYYY-MM-DDTHH:MM » (heure locale). */
  heures: z
    .object({
      faite: z.string().nullable(),
      /** `fin` : la fin du dernier échec, d'où comptent les 15 min avant le réessai. */
      echecs: z.object({ heure: z.string(), nombre: z.number().int().min(0), fin: z.string().optional() }).nullable(),
    })
    .optional(),
  /**
   * Pendant une exécution (statut en-cours) : l'état d'avant, remis au démarrage suivant si WebAiOs s'est arrêté
   * brutalement. Jamais affiché ; absent hors d'une exécution.
   */
  avant: z.object({ statut: StatutWidget, erreur: z.string().optional(), erreurNoyau: z.literal(true).optional() }).optional(),
});
export type EtatWidget = z.infer<typeof EtatWidget>;

export const ETAT_WIDGET_PAR_DEFAUT: EtatWidget = { statut: "ok", derniereMaj: null, derniereTentative: null };

export type WidgetLu =
  | {
      id: string;
      dossier: string;
      declaration: DeclarationWidget;
      etat: EtatWidget;
      donnees: unknown | null;
      exemple: unknown | null;
      /** Le widget a une récolte : `workflow.json` ou `recolte.mjs`. */
      aRecolte: boolean;
      /** `workflow.json` présent (il l'emporte alors sur `recolte.mjs`). */
      aWorkflow: boolean;
      aAffichage: boolean;
    }
  | { id: string; dossier: string; erreur: string };

export interface EtatAccueil {
  disposition: Placement[];
  widgets: WidgetLu[];
}
