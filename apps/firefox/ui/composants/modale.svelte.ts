import type { Bornes } from "../../shared/api";
import type { PendingRequest } from "../../shared/modele";

/**
 * Modal for an agent request, mounted at window level. `masqueurs`: number of mounted frozen backgrounds (modal,
 * ⌃Tab panel); above 0, the page's native view fades (it would cover them). `zone`: last bounds of the content area,
 * where to place the page's blurred capture.
 */
export const modale = $state<{ masqueurs: number; zone: Bornes | null }>({ masqueurs: 0, zone: null });

/**
 * The agent's requests (read, dev tools, widget data) and the extensions' grant cards open as a modal; those from
 * sites stay a banner.
 */
export const estDemandeAgent = (d: PendingRequest) =>
  d.permissions.includes("lire-onglet") ||
  d.permissions.includes("outils-dev") ||
  d.permissions.includes("donnees-widget") ||
  d.permissions.includes("extension") ||
  d.permissions.includes("console-extension");
