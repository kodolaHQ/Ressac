import { BORD_REVELATION, LARGEUR_BARRE, MARGE_BARRE, SORTIE_GAUCHE } from "./modele";

/**
 * Mode compact : où est la souris par rapport au bord gauche de la fenêtre. « bord » révèle la barre, « barre » la
 * garde ouverte (la barre et une marge à sa droite), « loin » la referme.
 */
export type ZoneGauche = "bord" | "barre" | "loin";

/** Zone de la souris à `x` px du bord gauche de la fenêtre. */
export function zoneGauche(x: number): ZoneGauche {
  if (x < BORD_REVELATION) return "bord";
  return x < LARGEUR_BARRE + MARGE_BARRE ? "barre" : "loin";
}

/** Zone d'une souris qui sort d'une surface (page, interface) après avoir été vue en dernier à `x` : un geste rapide vers la gauche compte comme le bord. */
export function zoneSortie(x: number): ZoneGauche {
  return x < SORTIE_GAUCHE ? "bord" : zoneGauche(x);
}

export interface Revelation {
  revelee: boolean;
  /** La souris a quitté le bord depuis le dernier masquage : y revenir révèle de nouveau la barre. */
  armee: boolean;
}

export const REVELATION_INITIALE: Revelation = { revelee: false, armee: true };

/**
 * La souris passe dans `zone`. Hystérésis : la barre se révèle au bord, reste ouverte sur elle-même et sa marge, et ne
 * se referme (`masquer`, après un court délai) qu'au-delà ; une souris restée au bord après un masquage doit le quitter
 * avant de la révéler de nouveau. Ainsi la page qui se décale sous une souris immobile ne fait pas clignoter la barre.
 */
export function surZone(r: Revelation, zone: ZoneGauche): Revelation & { masquer: boolean } {
  const armee = r.armee || zone !== "bord";
  if (r.revelee) return { revelee: true, armee, masquer: zone === "loin" };
  return { revelee: zone === "bord" && armee, armee, masquer: false };
}

/** La barre se masque alors que la souris est dans `zone`. */
export function masquer(zone: ZoneGauche): Revelation {
  return { revelee: false, armee: zone !== "bord" };
}
