/**
 * Canaux et monde du preload `site.js`. Dans son propre fichier : le preload n'importe rien que le preload de l'interface
 * importe aussi (sinon le bundler en ferait un morceau partagé, qu'un preload en bac à sable ne peut pas charger).
 */
export const CANAUX_PRELOAD_SITE = {
  /** Ce qui va dans ce cadre (synchrone), décidé par le process principal depuis l'expéditeur. */
  injection: "webaios:site-injection",
  /** La mémoire de l'appli pour `webaiosSite` (cadre principal seulement). */
  memoire: "webaios:site-memoire",
  /** La position d'une vidéo du cadre (`{ t, duree, fin }`), notée sous l'adresse de la page principale. */
  position: "webaios:site-position",
  /** La position à reprendre pour la page principale (`{ duree }`), si elle appartient à une vidéo de cette durée. */
  reprise: "webaios:site-reprise",
} as const;

/**
 * Monde isolé des retouches de l'agent dans la vue d'une appli de site : ni celui de la page, ni celui du preload (999,
 * qui a `ipcRenderer`), ni celui du balayage (1001).
 */
export const MONDE_RETOUCHES = 1100;
