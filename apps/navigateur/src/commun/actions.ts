import type { Execution } from "@webaios/noyau";

/** Les actions : messages de l'interface, adresses des images et des composants (aussi lues par l'interface). */
export const ACTIONS_EN_ESPACE_PRIVE = "Les actions ne sont pas disponibles dans un espace privé";
export const EN_ATTENTE = "En attente : deux actions tournent déjà";
export const MISE_EN_PAGE = "Mise en page…";
export const lectureDe = (hote: string) => `Lecture de ${hote}…`;
/** Recopiés du noyau (pages/resoudre.ts ; un test vérifie l'égalité) : l'interface n'en importe que des types. */
export const MENTION_SECOURS = "mise en page simple";
export const AUCUN_RESULTAT = "Aucun résultat";

/** Images des résultats d'une action, cherchées par le process principal (voir main/agent/actions.ts). */
export const SCHEMA_IMAGE = "webaios-image";
/** Composants de l'agent (`~/WebAiOs/composants/<nom>/composant.html`), servis sans réseau comme un widget. */
export const SCHEMA_COMPOSANT = "webaios-composant";

export const urlImage = (id: string, execution: string, url: string) => `${SCHEMA_IMAGE}://${id}/${execution}?u=${encodeURIComponent(url)}`;
export const urlComposant = (nom: string) => `${SCHEMA_COMPOSANT}://${nom}/composant.html`;

const NOM_COMPOSANT = /^[a-z0-9-]{1,40}$/;
/** Le composant dont `url` est le fichier (`webaios-composant://<nom>/composant.html`, paramètres permis), sinon null. */
export function composantDuCadre(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === `${SCHEMA_COMPOSANT}:` && NOM_COMPOSANT.test(u.hostname) && u.pathname === "/composant.html" ? u.hostname : null;
}

/** Une action telle que la page « Actions » et les suggestions la montrent. */
export type ActionAffichee = {
  id: string;
  nom: string;
  description: string;
  motsCles: string[];
  saisie: { libelle: string } | null;
  /** Domaines lus avec le compte de l'utilisateur (vide : sources publiques seulement). */
  compte: string[];
  /** L'accord du compte est donné. */
  accord: boolean;
  /** La plus récente vraie exécution (pas un essai). */
  dernier: { execution: string; debut: string; statut: Execution["statut"] } | null;
  /** `action.json` illisible ou invalide. */
  erreur?: string;
};
