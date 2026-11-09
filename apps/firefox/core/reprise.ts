/**
 * Video resume at the minute (tested alone): what the site actor (chrome/agent/site-actor.ts) does with the events of
 * each frame's `<video>`s. Nothing here imports the noyau: this file is bundled into the actor.
 */

/** Une vidéo plus courte (publicité, aperçu) n'est ni suivie ni reprise. */
export const DUREE_MIN_REPRISE_S = 60;
/** Pendant la lecture, une position notée au plus toutes les 10 s. */
export const ECART_POSITION_MS = 10_000;
/** Reprendre un peu avant l'endroit quitté. */
export const RECUL_REPRISE_S = 5;

export type EvenementVideo = "loadedmetadata" | "play" | "timeupdate" | "pause" | "ended";
export const EVENEMENTS_VIDEO: readonly EvenementVideo[] = ["loadedmetadata", "play", "timeupdate", "pause", "ended"];

type Etat = { reglee: boolean; derniere: number | null };

export class SuiviReprise {
  /** Par élément : sa reprise est-elle réglée (demandée et rendue), et quand sa position a-t-elle été notée. */
  private readonly etats = new WeakMap<object, Etat>();

  constructor(
    private readonly o: {
      /** `fin` : la vidéo est allée au bout (`ended`). */
      noter(t: number, duree: number, fin: boolean): void;
      /** La position retenue pour la page, si elle appartient à une vidéo de cette durée (décidé par le main). */
      demander(duree: number): Promise<number | null>;
      maintenant(): number;
    },
  ) {}

  /**
   * Un événement d'un élément (`cle`) : la position à donner à `currentTime`, ou null. Au premier événement où la durée
   * est connue et assez longue, la position de la page est demandée avec sa durée, une seule fois par élément ; rien n'est noté avant
   * qu'elle soit rendue (un `timeupdate` à 0 s n'écrase pas la position retenue).
   */
  async surEvenement(type: EvenementVideo, v: { currentTime: number; duration: number; cle: object }): Promise<number | null> {
    const { currentTime: t, duration: duree } = v;
    if (!Number.isFinite(duree) || duree < DUREE_MIN_REPRISE_S || !Number.isFinite(t) || t < 0) return null;
    const etat = this.etats.get(v.cle);
    if (!etat) {
      const nouveau: Etat = { reglee: false, derniere: null };
      this.etats.set(v.cle, nouveau);
      let p: number | null = null;
      try {
        p = await this.o.demander(duree);
      } catch {
        p = null;
      }
      nouveau.reglee = true;
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p >= duree) return null;
      return Math.max(0, p - RECUL_REPRISE_S);
    }
    if (!etat.reglee) return null;
    if (type === "pause" || type === "ended") this.noter(etat, t, duree, type === "ended");
    else if (type === "timeupdate") {
      const maintenant = this.o.maintenant();
      if (etat.derniere === null || maintenant - etat.derniere >= ECART_POSITION_MS) this.noter(etat, t, duree, false);
    }
    return null;
  }

  private noter(etat: Etat, t: number, duree: number, fin: boolean): void {
    etat.derniere = this.o.maintenant();
    try {
      this.o.noter(t, duree, fin);
    } catch {
      // une position est un confort
    }
  }
}
