/** Messages des extensions (désactivation, déblocage de la console), lus aussi par l'interface : ce module n'importe rien. */
export const DESACTIVEE_PLANTAGES = "Désactivée : elle a planté 3 fois en une minute";
export const DESACTIVEE_PORTEE = "Désactivée : elle demande plus de droits qu'accordé";

/** La ligne de la page Extensions pendant un déblocage de la console. */
export const CONSOLE_DEBLOQUEE_PAGE = "Console débloquée pour l'agent";
/** La raison de l'agent, sur la carte de déblocage, est coupée à cette longueur. */
export const LONGUEUR_RAISON_DEBLOCAGE = 200;
/**
 * Le texte de la carte de déblocage de la console (le nom de l'extension et ceux des espaces sont des données, affichés
 * en texte) : les espaces des profils où elle est active, que le déblocage couvre.
 */
export const texteDeblocageConsole = (nom: string, espaces: readonly string[] = []) => {
  const lieu =
    espaces.length === 0 ? "des profils où elle est active" : espaces.length === 1 ? `de l'espace « ${espaces[0]} »` : `des espaces ${espaces.map((e) => `« ${e} »`).join(", ")}`;
  return `L'agent demande à voir toute la console de « ${nom} » pour la corriger. Il verra ce que l'extension écrit dans sa console sur tous les onglets ${lieu}, y compris ceux que tu ne partages pas. Jusqu'à ce que tu le coupes ou qu'il ait fini.`;
};
