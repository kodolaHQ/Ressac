import type { Bornes } from "../../commun/api";
import type { DemandeEnAttente } from "../../commun/modele";

/**
 * Modale d'une demande de l'agent, montée au niveau de la fenêtre. `masquer` : la vue native de la page s'efface
 * (elle couvrirait la modale). `zone` : dernières bornes de la zone de contenu, où placer la capture floutée de la page.
 */
export const modale = $state<{ masquer: boolean; zone: Bornes | null }>({ masquer: false, zone: null });

/** Les demandes de l'agent (lecture, outils de développement) s'ouvrent en modale ; celles des sites restent un bandeau. */
export const estDemandeAgent = (d: DemandeEnAttente) => d.permissions.includes("lire-onglet") || d.permissions.includes("outils-dev");
