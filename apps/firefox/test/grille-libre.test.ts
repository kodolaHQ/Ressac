import { describe, expect, it } from "vitest";
import type { PlacementLibre } from "../../../packages/noyau/src/accueil/schemas";
import { deplacerLibre, guidesLibres, LARGEUR_LIBRE, redimensionnerLibre } from "../ui/grille-libre";

const place = (o: Partial<PlacementLibre> = {}): PlacementLibre => ({ id: "a", x: 0, y: 0, l: 200, h: 180, ...o });

describe("deplacerLibre", () => {
  it("s'arrête au bord d'un autre widget sans le déplacer", () => {
    const autre = place({ id: "b", x: 400 });
    const r = deplacerLibre({ p: place(), x: 350, y: 0, autres: [autre] });
    expect(r).toEqual({ id: "a", x: 200, y: 0, l: 200, h: 180 });
    expect(autre).toEqual({ id: "b", x: 400, y: 0, l: 200, h: 180 });
  });

  it("ne sort jamais de x + l ≤ 1000", () => {
    const r = deplacerLibre({ p: place({ x: 100 }), x: 950, y: 0, autres: [] });
    expect(r.x + r.l).toBeLessThanOrEqual(LARGEUR_LIBRE);
    expect(r.x).toBe(800);
  });

  it("s'arrête aussi en venant de la droite et du bas", () => {
    const autre = place({ id: "b", x: 400, y: 200 });
    expect(deplacerLibre({ p: place({ x: 700, y: 200 }), x: 450, y: 200, autres: [autre] }).x).toBe(600);
    expect(deplacerLibre({ p: place({ x: 400, y: 0 }), x: 400, y: 300, autres: [autre] }).y).toBe(20);
  });

  it("ne téléporte pas l'aperçu sur un glisser diagonal : un seul axe se borne", () => {
    // Le voisin est en bas à droite ; l'axe horizontal a bougé le plus : son bord gauche gagne, y reste où le pointeur
    // l'a mis (pas de saut au coin (200, 20) du voisin).
    const autre = place({ id: "b", x: 400, y: 200 });
    const r = deplacerLibre({ p: place(), x: 350, y: 304, autres: [autre] });
    expect(r.x).toBe(200);
    expect(r.y).toBe(304);
  });
});

describe("redimensionnerLibre", () => {
  it("borne la taille entre min et max", () => {
    const grand = redimensionnerLibre({ p: place(), l: 900, h: 900, min: { l: 100, h: 90 }, max: { l: 500, h: 360 }, autres: [] });
    expect(grand).toMatchObject({ l: 500, h: 360 });
    const petit = redimensionnerLibre({ p: place(), l: 1, h: 1, min: { l: 100, h: 90 }, max: { l: 500, h: 360 }, autres: [] });
    expect(petit).toMatchObject({ l: 100, h: 90 });
  });

  it("ne déborde pas à droite de l'accueil", () => {
    const r = redimensionnerLibre({ p: place({ x: 900 }), l: 300, h: 180, min: { l: 50, h: 90 }, max: { l: 500, h: 360 }, autres: [] });
    expect(r.x + r.l).toBeLessThanOrEqual(LARGEUR_LIBRE);
    expect(r.l).toBe(100);
  });

  it("s'arrête au bord gauche d'un voisin, jamais de chevauchement", () => {
    const autre = place({ id: "b", x: 500 });
    const r = redimensionnerLibre({ p: place(), l: 900, h: 180, min: { l: 167, h: 90 }, max: { l: 900, h: 360 }, autres: [autre] });
    expect(r.x + r.l).toBe(500);
    expect(r.l).toBe(500);
  });

  it("recule au lieu de descendre sous le minimum près du bord droit", () => {
    // Le minimum (200 ‰) ne tient pas après x = 950 : le widget glisse à gauche, sa largeur reste au minimum.
    const r = redimensionnerLibre({ p: place({ x: 950 }), l: 200, h: 180, min: { l: 200, h: 90 }, max: { l: 500, h: 360 }, autres: [] });
    expect(r.x).toBe(800);
    expect(r.l).toBe(200);
    expect(r.x + r.l).toBe(LARGEUR_LIBRE);
  });
});

describe("guidesLibres", () => {
  it("rend un guide quand les bords gauches coïncident", () => {
    // 400 ‰ de 1280 px : le guide est rendu en pixels, pas en millièmes.
    const r = guidesLibres({ p: place({ x: 400 }), autres: [place({ id: "b", x: 400, y: 300 })], largeurPx: 1280 });
    expect(r.x).toContain(512);
  });

  it("ne rend aucun guide sans alignement", () => {
    const r = guidesLibres({ p: place({ x: 100 }), autres: [place({ id: "b", x: 700, y: 300 })], largeurPx: 1000 });
    expect(r.x).not.toContain(100);
    expect(r.x).not.toContain(700);
  });
});
