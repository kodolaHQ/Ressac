import { z } from "zod";

export const COLONNES = 12;
export const TAILLE_MAX_DONNEES = 2 * 1024 * 1024;

/** Nom d'hôte en minuscules (« news.ycombinator.com »). */
const domaine = z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, "nom d'hôte en minuscules attendu");
const cote = z.number().int().min(1).max(12);
const taille = z.object({ l: cote, h: cote });

export const WEB_AVEC_COMPTE = "web : impossible avec un compte (les données d'un compte ne doivent pas pouvoir partir vers un site inconnu)";

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
    sources: z
      .object({ compte: z.array(domaine).default([]), publiques: z.array(domaine).default([]), web: z.boolean().default(false) })
      .default({ compte: [], publiques: [], web: false }),
    config: z.unknown().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.sources.web && d.sources.compte.length > 0) {
      ctx.addIssue({ code: "custom", path: ["sources", "web"], message: WEB_AVEC_COMPTE });
    }
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

export const EtatWidget = z.object({
  statut: z.enum(["ok", "en-cours", "erreur", "accord-requis", "atelier-arrete"]),
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
      echecs: z.object({ heure: z.string(), nombre: z.number().int().min(0) }).nullable(),
    })
    .optional(),
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
