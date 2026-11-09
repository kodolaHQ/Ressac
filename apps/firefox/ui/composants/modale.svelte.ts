import type { Bornes } from "../../shared/api";
import type { DemandeEnAttente } from "../../shared/modele";

/**
 * Modale d'une demande de l'agent, montée au niveau de la fenêtre. `masqueurs` : nombre de fonds figés montés (modale,
 * panneau ⌃Tab) ; au-dessus de 0, la vue native de la page s'efface (elle les couvrirait). `zone` : dernières bornes de la zone de contenu, où placer la capture floutée de la page.
 */
export const modale = $state<{ masqueurs: number; zone: Bornes | null }>({ masqueurs: 0, zone: null });

/**
 * Les demandes de l'agent (lecture, outils de développement, données d'un widget) et les cartes d'accord des extensions
 * s'ouvrent en modale ; celles des sites restent un bandeau.
 */
export const estDemandeAgent = (d: DemandeEnAttente) =>
  d.permissions.includes("lire-onglet") ||
  d.permissions.includes("outils-dev") ||
  d.permissions.includes("donnees-widget") ||
  d.permissions.includes("extension") ||
  d.permissions.includes("console-extension");
