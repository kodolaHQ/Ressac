/** What changed for the user, newest first. Add an entry when bumping `version` in package.json: its page opens once after the update. */
export const RELEASE_NOTES: { version: string; date: string; items: string[] }[] = [
  {
    version: "0.1.3",
    date: "novembre 2026",
    items: [
      "L'agent cherche sur le web dans son propre onglet, que vous voyez travailler : une bande dit ce qu'il fait, et il vous rend la main (« à vous ») s'il est bloqué.",
      "Quand l'agent veut ouvrir une adresse qu'il a écrite lui-même, une carte vous la montre avec sa raison avant de l'ouvrir.",
      "Appels (Meet, Teams, Zoom…) : en changeant d'onglet, la vidéo de l'appel flotte et une barre en bas de la barre latérale garde le micro, la caméra et le retour à l'appel.",
      "Vidéo ou musique en arrière-plan : une barre en bas de la barre latérale pour mettre en pause, couper le son ou revenir à l'onglet.",
      "Un haut-parleur sur l'onglet qui émet du son ; un clic le coupe.",
      "La largeur de la barre des onglets se règle en tirant son bord.",
      "Les essentiels se réordonnent par glisser-déposer.",
      "La fenêtre se déplace plus facilement : par le haut de la page, les marges de la barre latérale, le vide sous les onglets et l'en-tête du panneau agent.",
      "WhatsApp Web et d'autres sites qui refusaient WebAiOs fonctionnent.",
      "Le lien de connexion affiché par Claude Code dans le panneau agent s'ouvre dans un onglet.",
      "Les onglets épinglés et les essentiels affichent l'icône à jour du site (messages non lus).",
      "Les icônes de site en SVG (GitHub…) s'affichent au lieu d'une lettre.",
    ],
  },
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
