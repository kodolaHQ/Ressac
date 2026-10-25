/** Sans dépendance : importé par le preload, qui tourne en bac à sable et ne peut charger aucun module. */
export const CANAUX = {
  action: "webaios:action",
  etat: "webaios:etat",
  demanderEtat: "webaios:demander-etat",
  naviguer: "webaios:naviguer",
  commande: "webaios:commande",
  bornes: "webaios:bornes",
  bordGauche: "webaios:bord-gauche",
  panneau: "webaios:panneau",
  historiqueRechercher: "webaios:historique-rechercher",
  historiqueRecents: "webaios:historique-recents",
  historiqueEffacer: "webaios:historique-effacer",
  telechargements: "webaios:telechargements",
  telechargementsListe: "webaios:telechargements-liste",
  telechargementAction: "webaios:telechargement-action",
} as const;

export const ARG_FENETRE = "--webaios-fenetre=";
