/** The vim mode's keys, grouped, in French: the one source of the Settings table and of the `?` sheet in pages (bundled into the vim actor). */
export const VIM_KEYS: readonly { title: string; rows: readonly { keys: readonly string[]; action: string }[] }[] = [
  {
    title: "Défiler",
    rows: [
      { keys: ["j", "k"], action: "Une ligne vers le bas / le haut" },
      { keys: ["h", "l"], action: "À gauche / à droite" },
      { keys: ["d", "u"], action: "Une demi-page vers le bas / le haut" },
      { keys: ["gg", "G"], action: "Haut / bas de la page" },
    ],
  },
  {
    title: "Naviguer",
    rows: [
      { keys: ["H", "L"], action: "Page précédente / suivante" },
      { keys: ["r"], action: "Recharger" },
      { keys: ["o"], action: "Barre d'adresse" },
      { keys: ["yy"], action: "Copier l'adresse de la page" },
    ],
  },
  {
    title: "Onglets et espaces",
    rows: [
      { keys: ["J", "K"], action: "Onglet précédent / suivant, en boucle" },
      { keys: ["gT", "gt"], action: "Onglet précédent / suivant, en boucle" },
      { keys: ["g0", "g$"], action: "Premier / dernier onglet de l'espace" },
      { keys: ["t"], action: "Nouvel onglet (barre de commande)" },
      { keys: ["x"], action: "Fermer l'onglet" },
      { keys: ["X"], action: "Rouvrir l'onglet fermé" },
      { keys: ["gs", "gS"], action: "Espace suivant / précédent, en boucle" },
    ],
  },
  {
    title: "Liens et recherche",
    rows: [
      { keys: ["f"], action: "Des lettres sur les liens visibles : tapez-les pour ouvrir le lien" },
      { keys: ["F"], action: "Pareil, dans un nouvel onglet" },
      { keys: ["/"], action: "Rechercher dans la page" },
    ],
  },
  {
    title: "Pause",
    rows: [
      { keys: ["i"], action: "Mettre les touches vim en pause dans cet onglet : tout va à la page" },
      { keys: ["⇧Échap"], action: "Reprendre (ou mettre en pause)" },
      { keys: ["Échap"], action: "Quitter les lettres ou un préfixe en cours" },
      { keys: ["?"], action: "Afficher cette aide" },
    ],
  },
];
