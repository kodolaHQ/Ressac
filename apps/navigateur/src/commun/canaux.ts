/** Sans dépendance : importé par le preload, qui tourne en bac à sable et ne peut charger aucun module. */
export const CANAUX = {
  action: "webaios:action",
  etat: "webaios:etat",
  demanderEtat: "webaios:demander-etat",
  naviguer: "webaios:naviguer",
  commande: "webaios:commande",
  bornes: "webaios:bornes",
} as const;

export const ARG_FENETRE = "--webaios-fenetre=";
