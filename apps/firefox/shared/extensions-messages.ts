/** Messages of the extensions (deactivation, console unlock), also read by the UI: this module imports nothing. */
export const DESACTIVEE_PLANTAGES = "Désactivée : elle a planté 3 fois en une minute";
export const DESACTIVEE_PORTEE = "Désactivée : elle demande plus de droits qu'accordé";

/** The Extensions page row during a console unlock. */
export const CONSOLE_DEBLOQUEE_PAGE = "Console débloquée pour l'agent";
/** The agent's reason, on the unlock card, is cut to this length. */
export const LONGUEUR_RAISON_DEBLOCAGE = 200;
/**
 * The text of the console unlock card (the extension's name and those of the spaces are data, displayed
 * as text): the spaces of the profiles where it is active, which the unlock covers.
 */
export const texteDeblocageConsole = (nom: string, espaces: readonly string[] = []) => {
  const lieu =
    espaces.length === 0 ? "des profils où elle est active" : espaces.length === 1 ? `de l'espace « ${espaces[0]} »` : `des espaces ${espaces.map((e) => `« ${e} »`).join(", ")}`;
  return `L'agent demande à voir toute la console de « ${nom} » pour la corriger. Il verra ce que l'extension écrit dans sa console sur tous les onglets ${lieu}, y compris ceux que tu ne partages pas. Jusqu'à ce que tu le coupes ou qu'il ait fini.`;
};

// ——— Extensions in a site app (plan 16) ———
/** A site app's « Extensions » menu, with no Store extension installed. */
export const AUCUNE_EXTENSION_SITE = "Aucune extension installée. Installe-en depuis le Chrome Web Store dans un onglet.";
/** Enabled for other domains than the app's current ones: nothing is loaded. */
export const DOMAINES_CHANGES_EXTENSION = "Les domaines de l'appli ont changé : réactive si tu veux";
export const VOIT_LES_PAGES_SITE = "Elle verra les pages de l'appli, connectées à ton compte.";
export const GERER_EXTENSIONS = "Gérer les extensions";
export const APPLI_FERMEE = "Appli de site fermée : ouvre-la pour y activer une extension";
/** The Extensions page: the site apps where it is active. */
export const activeDans = (noms: string[]) => `Active dans : ${noms.join(", ")}`;
