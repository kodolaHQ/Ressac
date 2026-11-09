import type { Execution } from "@webaios/noyau";

/** Les actions : messages de l'interface, adresses des images et des composants (aussi lues par l'interface). */
export const ACTIONS_EN_ESPACE_PRIVE = "Les actions ne sont pas disponibles dans un espace privé";
/** Le constructeur lance ou rejoue une action qui tourne déjà (depuis sa page, une autre fenêtre…) : rien ne part. */
export const ACTION_TOURNE_DEJA = "L'action tourne déjà";
export const EN_ATTENTE = "En attente : deux actions tournent déjà";
export const MISE_EN_PAGE = "Mise en page…";
export const lectureDe = (hote: string) => `Lecture de ${hote}…`;
/** Recopiés du noyau (pages/resoudre.ts ; un test vérifie l'égalité) : l'interface n'en importe que des types. */
export const MENTION_SECOURS = "mise en page simple";
export const AUCUN_RESULTAT = "Aucun résultat";
/** Recopié du noyau (actions/executer.ts ; même test d'égalité). */
export const ACTION_INCONNUE = "Action inconnue";
/** Une page `webaios://action/<id>/<exécution>` dont l'exécution a été effacée (ou n'a jamais existé). */
export const RESULTAT_DISPARU = "Ce résultat n'existe plus";

/** An action's result images, fetched by the chrome (chrome/store/action-media.ts). */
export const SCHEMA_IMAGE = "webaios-image";

export const urlImage = (id: string, execution: string, url: string) => `${SCHEMA_IMAGE}://${id}/${execution}?u=${encodeURIComponent(url)}`;

/** Une action telle que la page « Actions » et les suggestions la montrent. */
export type ActionAffichee = {
  id: string;
  nom: string;
  description: string;
  motsCles: string[];
  saisie: { libelle: string } | null;
  /** Domaines lus avec le compte de l'utilisateur (vide : sources publiques seulement). */
  compte: string[];
  /** Sites publics que l'action contacte (montrés sur la carte d'accord du compte). */
  publiques: string[];
  /** L'accord du compte est donné. */
  accord: boolean;
  /** La plus récente vraie exécution (pas un essai). */
  dernier: { execution: string; debut: string; statut: Execution["statut"] } | null;
  /** `action.json` illisible ou invalide. */
  erreur?: string;
  /** Le dernier lancement a été refusé sans rien écrire (atelier arrêté, workflow.json absent…) : son message. */
  refus?: string;
};
