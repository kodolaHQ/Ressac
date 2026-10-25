import { z } from "zod";
import type { Decision, DemandeEnAttente, EtatNavigateur, IdFenetre, IdOnglet, Telechargement, Visite } from "./modele";

export { ARG_FENETRE, CANAUX } from "./canaux";

const id = z.string().min(1);
const moteur = z.enum(["google", "duckduckgo", "qwant"]);

/** Les actions, validées à l'entrée du process principal : le schéma est la source du type. */
export const SchemaAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ouvrirOnglet"),
    fenetreId: id,
    url: z.string(),
    espaceId: id.optional(),
    activer: z.boolean().optional(),
    ouvertParAgent: z.boolean().optional(),
    apres: id.optional(),
  }),
  z.object({ type: z.literal("fermerOnglet"), id }),
  z.object({ type: z.literal("activerOnglet"), id }),
  z.object({ type: z.literal("deplacerOnglet"), id, index: z.number().int() }),
  z.object({ type: z.literal("rouvrirOngletFerme"), fenetreId: id }),
  z.object({
    type: z.literal("majOnglet"),
    id,
    champs: z
      .object({
        url: z.string(),
        titre: z.string(),
        favicon: z.string().nullable(),
        chargement: z.boolean(),
        peutReculer: z.boolean(),
        peutAvancer: z.boolean(),
        zoom: z.number(),
        plante: z.boolean(),
      })
      .partial(),
  }),
  z.object({ type: z.literal("ouvrirFavori"), fenetreId: id, genre: z.enum(["essentiel", "epingle"]), id }),
  z.object({ type: z.literal("epinglerOnglet"), id }),
  z.object({ type: z.literal("desepingler"), espaceId: id, favoriId: id }),
  z.object({ type: z.literal("ajouterEssentiel"), id }),
  z.object({ type: z.literal("retirerEssentiel"), favoriId: id }),
  z.object({ type: z.literal("creerEspace"), nom: z.string().min(1), icone: z.string().min(1), fenetreId: id.optional() }),
  z.object({ type: z.literal("renommerEspace"), id, nom: z.string().min(1), icone: z.string().min(1) }),
  z.object({ type: z.literal("supprimerEspace"), id }),
  z.object({ type: z.literal("activerEspace"), fenetreId: id, id }),
  z.object({ type: z.literal("ouvrirFenetre"), id: id.optional(), espaceId: id.optional() }),
  z.object({ type: z.literal("fermerFenetre"), id }),
  z.object({ type: z.literal("afficherPageVide"), fenetreId: id }),
  z.object({ type: z.literal("basculerCompact"), fenetreId: id }),
  z.object({ type: z.literal("basculerPanneauAgent"), fenetreId: id }),
  z.object({ type: z.literal("choisirMoteur"), moteur }),
]);
export type Action = z.infer<typeof SchemaAction>;

export const SchemaCommande = z.union([
  z.object({ ongletId: id, c: z.enum(["reculer", "avancer", "recharger", "arreter", "finRecherche"]) }),
  z.object({ ongletId: id, c: z.object({ zoom: z.enum(["plus", "moins", "zero"]) }) }),
  z.object({ ongletId: id, c: z.object({ chercher: z.string(), suivant: z.boolean().optional() }) }),
]);
export type CommandeOnglet = z.infer<typeof SchemaCommande>["c"];

export const SchemaBornes = z.object({ x: z.number(), y: z.number(), largeur: z.number(), hauteur: z.number() });
export type Bornes = z.infer<typeof SchemaBornes>;

export type Panneau = "historique" | "telechargements";

/** API exposée à l'interface par le preload (`window.webaios`). */
export interface ApiWebaios {
  fenetreId: IdFenetre;
  agir(action: Action): void;
  surEtat(rappel: (e: EtatNavigateur) => void): () => void;
  /** `ongletId` null : la saisie ouvre un nouvel onglet (page vide). */
  naviguer(ongletId: IdOnglet | null, saisie: string): void;
  commande(ongletId: IdOnglet, c: CommandeOnglet): void;
  bornesContenu(b: Bornes): void;
  /** Mode compact : la souris entre (true) ou sort (false) de la bande de 8 px du bord gauche, au-dessus d'une page web. */
  surBordGauche(rappel: (dedans: boolean) => void): () => void;
  /** Le menu demande d'ouvrir un panneau de l'interface (⌘Y…). */
  surPanneau(rappel: (p: Panneau) => void): () => void;
  historique: {
    rechercher(texte: string, limite?: number): Promise<Visite[]>;
    recents(): Promise<Visite[]>;
    /** `depuis` : date ISO ; absent, tout l'historique. */
    effacer(depuis?: string): Promise<void>;
  };
  telechargements: {
    liste(): Promise<Telechargement[]>;
    ouvrir(id: string): void;
    montrer(id: string): void;
    annuler(id: string): void;
  };
  surTelechargements(rappel: (liste: Telechargement[]) => void): () => void;
  permissions: {
    enAttente(): Promise<DemandeEnAttente[]>;
    repondre(id: string, decision: Decision): void;
  };
  surPermissions(rappel: (liste: DemandeEnAttente[]) => void): () => void;
}

export const SchemaActionTelechargement = z.object({ id, action: z.enum(["ouvrir", "montrer", "annuler"]) });
export const SchemaReponsePermission = z.object({ id, decision: z.enum(["autoriser", "refuser"]) });
