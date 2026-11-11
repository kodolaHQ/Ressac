/** Messages of the extensions (deactivation, console unlock), also read by the UI: this module imports nothing. */
export const DISABLED_CRASHES = "Désactivée : elle a planté 3 fois en une minute";
export const DISABLED_SCOPE = "Désactivée : elle demande plus de droits qu'accordé";

/** The Extensions page row during a console unlock. */
export const CONSOLE_UNLOCKED_PAGE = "Console débloquée pour l'agent";
/** The agent's reason, on the unlock card, is cut to this length. */
export const UNLOCK_REASON_LENGTH = 200;
/**
 * The text of the console unlock card (the extension's name and those of the spaces are data, displayed
 * as text): the spaces of the profiles where it is active, which the unlock covers.
 */
export const unlockedConsoleText = (name: string, spaces: readonly string[] = []) => {
  const where =
    spaces.length === 0 ? "des profils où elle est active" : spaces.length === 1 ? `de l'espace « ${spaces[0]} »` : `des espaces ${spaces.map((e) => `« ${e} »`).join(", ")}`;
  return `L'agent demande à voir toute la console de « ${name} » pour la corriger. Il verra ce que l'extension écrit dans sa console sur tous les onglets ${where}, y compris ceux que vous ne partagez pas. Jusqu'à ce que vous le coupiez ou qu'il ait fini.`;
};

// ——— Extensions in a site app (plan 16) ———
/** A site app's « Extensions » menu, with no Store extension installed. */
export const NO_SITE_EXTENSION = "Aucune extension installée. Installez-en depuis le Chrome Web Store dans un onglet.";
/** Enabled for other domains than the app's current ones: nothing is loaded. */
export const EXTENSION_CHANGED_DOMAINS = "Les domaines de l'appli ont changé : réactivez si vous le souhaitez";
export const SEES_SITE_PAGES = "Elle verra les pages de l'appli, connectées à votre compte.";
export const MANAGE_EXTENSIONS = "Gérer les extensions";
export const APP_CLOSED = "Appli de site fermée : ouvrez-la pour y activer une extension";
/** The Extensions page: the site apps where it is active. */
export const activeIn = (names: string[]) => `Active dans : ${names.join(", ")}`;
