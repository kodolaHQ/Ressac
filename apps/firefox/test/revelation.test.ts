import { describe, expect, it } from "vitest";
import { masquer, REVELATION_INITIALE, surZone, zoneGauche, zoneSortie, type Revelation, type ZoneGauche } from "../shared/revelation";

/** Rejoue des positions de souris (px depuis le bord gauche) ; un masquage demandé est appliqué aussitôt. */
function parcours(xs: number[], depart: Revelation = REVELATION_INITIALE): boolean[] {
  let r = depart;
  return xs.map((x) => {
    const zone = zoneGauche(x);
    const s = surZone(r, zone);
    r = s.masquer ? masquer(zone) : { revelee: s.revelee, armee: s.armee };
    return r.revelee;
  });
}

describe("zones du bord gauche", () => {
  it("bord sous 16 px, barre jusqu'à 280 px (240 + marge), loin au-delà", () => {
    expect([0, 15, 16, 239, 279, 280, 900].map(zoneGauche)).toEqual<ZoneGauche[]>(["bord", "bord", "barre", "barre", "barre", "loin", "loin"]);
  });
  it("une sortie rapide par la gauche compte comme le bord", () => {
    expect(zoneSortie(40)).toBe("bord");
    expect(zoneSortie(60)).toBe("barre");
    expect(zoneSortie(500)).toBe("loin");
  });
});

describe("révélation de la barre en mode compact", () => {
  it("se révèle au bord et reste ouverte tant que la souris est sur la barre ou sa marge", () => {
    expect(parcours([600, 100, 10, 3, 3, 100, 260, 279])).toEqual([false, false, true, true, true, true, true, true]);
  });
  it("une souris immobile au bord, revue à la même place, ne referme rien (la page s'est décalée dessous)", () => {
    expect(parcours([3, 3, 3, 3])).toEqual([true, true, true, true]);
  });
  it("se referme au-delà de la barre et de sa marge", () => {
    const s = surZone({ revelee: true, armee: true }, "loin");
    expect(s).toMatchObject({ revelee: true, masquer: true });
    expect(parcours([5, 120, 300])).toEqual([true, true, false]);
  });
  it("ne demande pas de masquage tant que la souris reste sur la barre", () => {
    expect(surZone({ revelee: true, armee: true }, "barre").masquer).toBe(false);
    expect(surZone({ revelee: true, armee: true }, "bord").masquer).toBe(false);
  });
  it("masquée avec la souris au bord, elle ne revient qu'après que la souris a quitté puis retrouvé le bord", () => {
    const r = masquer("bord");
    expect(parcours([3, 5, 2], r)).toEqual([false, false, false]);
    expect(parcours([3, 40, 3], r)).toEqual([false, false, true]);
  });
});
