/** What changed for the user, newest first. Add an entry when bumping `version` in package.json: its page opens once after the update. */
export const RELEASE_NOTES: { version: string; date: string; items: string[] }[] = [
  {
    version: "0.1.2",
    date: "novembre 2026",
    items: [
      "Import depuis un autre navigateur (Arc, Chrome, Brave, Edge, Vivaldi, Opera, Safari, Firefox, Zen) : favoris, historique et mots de passe. Dans l'accueil et dans Réglages › Données.",
      "Depuis Arc et Zen, l'import reprend aussi les espaces, les essentiels, les onglets épinglés et les onglets ouverts.",
      "Les favoris importés se retrouvent dans ⌘T, et l'agent peut y chercher.",
      "Dossiers d'onglets épinglés : clic droit sur un onglet épinglé › « Nouveau dossier », ou sur le nom de l'espace. Un onglet glissé sur un dossier s'y épingle.",
      "Clic droit sur un onglet › « Envoyer vers » pour le déplacer dans un autre espace.",
      "« Lancer » une action qui a besoin d'un compte demande d'abord l'autorisation, puis la lance.",
      "Docker ou OrbStack installé après le démarrage est détecté sans relancer WebAiOs.",
      "Cette page : elle s'ouvre une fois après chaque mise à jour, et reste dans Réglages › À propos.",
    ],
  },
];
