/** Messages of the extensions (deactivation, console unlock), also read by the UI: this module imports nothing. */
export const DISABLED_CRASHES = "Désactivée : elle a planté 3 fois en une minute";
export const DISABLED_SCOPE = "Désactivée : elle demande plus de droits qu'accordé";

/** The agent's reason, on the unlock card, is cut to this length. */
export const UNLOCK_REASON_LENGTH = 200;

// ——— Extensions in a site app (plan 16) ———
/** A site app's « Extensions » menu, with no Store extension installed. */
export const NO_SITE_EXTENSION = "Aucune extension installée. Installez-en depuis addons.mozilla.org dans un onglet.";
/** Enabled for other domains than the app's current ones: nothing is loaded. */
export const EXTENSION_CHANGED_DOMAINS = "Les domaines de l'appli ont changé : réactivez si vous le souhaitez";
export const SEES_SITE_PAGES = "Elle verra les pages de l'appli, connectées à votre compte.";
export const MANAGE_EXTENSIONS = "Gérer les extensions";
export const APP_CLOSED = "Appli de site fermée : ouvrez-la pour y activer une extension";
