import { describe, expect, it } from "vitest";
import type { PlacementLibre } from "../../../packages/noyau/src/accueil/schemas";
import { deplacerLibre, guidesLibres, LARGEUR_LIBRE, redimensionnerLibre } from "../ui/grille-libre";

const place = (o: Partial<PlacementLibre> = {}): PlacementLibre => ({ id: "a", x: 0, y: 0, l: 200, h: 180, ...o });

describe("deplacerLibre", () => {
  it("s'arrête au bord d'un autre widget sans le déplacer", () => {
    const autre = place({ id: "b", x: 400 });
    const r = deplacerLibre({ p: place(), x: 350, y: 0, autres: [autre], largeurPx: 1000 });
    expect(r).toEqual({ id: "a", x: 200, y: 0, l: 200, h: 180 });
    expect(autre).toEqual({ id: "b", x: 400, y: 0, l: 200, h: 180 });
  });

  it("ne sort jamais de x + l ≤ 1000", () => {
    const r = deplacerLibre({ p: place({ x: 100 }), x: 950, y: 0, autres: [], largeurPx: 1000 });
    expect(r.x + r.l).toBeLessThanOrEqual(LARGEUR_LIBRE);
    expect(r.x).toBe(800);
  });

  it("s'arrête aussi en venant de la droite et du bas", () => {
    const autre = place({ id: "b", x: 400, y: 200 });
    expect(deplacerLibre({ p: place({ x: 700, y: 200 }), x: 450, y: 200, autres: [autre], largeurPx: 1000 }).x).toBe(600);
    expect(deplacerLibre({ p: place({ x: 400, y: 0 }), x: 400, y: 300, autres: [autre], largeurPx: 1000 }).y).toBe(20);
  });

  it("ne téléporte pas l'aperçu sur un glisser diagonal : un seul axe se borne", () => {
    // Le voisin est en bas à droite ; l'axe horizontal a bougé le plus : son bord gauche gagne, y reste où le pointeur
    // l'a mis (pas de saut au coin (200, 20) du voisin).
    const autre = place({ id: "b", x: 400, y: 200 });
    const r = deplacerLibre({ p: place(), x: 350, y: 304, autres: [autre], largeurPx: 1000 });
    expect(r.x).toBe(200);
    expect(r.y).toBe(304);
  });

  it("compare les deux axes en pixels : sur un accueil étroit, la verticale l'emporte", () => {
    // 350 ‰ de 500 px = 175 px, moins que les 304 px verticaux : c'est le bord haut qui gagne.
    const autre = place({ id: "b", x: 400, y: 200 });
    const r = deplacerLibre({ p: place(), x: 350, y: 304, autres: [autre], largeurPx: 500 });
    expect(r.x).toBe(350);
    expect(r.y).toBe(20);
  });

  it("un long glisser traverse un voisin jusqu'au bord droit, sans le déplacer", () => {
    // Le pointeur va bien au-delà du voisin (500…750) : l'aperçu le survole et s'arrête au bord droit (1000 - 250).
    const autre = place({ id: "b", x: 500, l: 250 });
    const r = deplacerLibre({ p: place({ l: 250 }), x: 1200, y: 0, autres: [autre], largeurPx: 1000 });
    expect(r.x).toBe(750);
    expect(r.x + r.l).toBe(LARGEUR_LIBRE);
    expect(autre).toEqual({ id: "b", x: 500, y: 0, l: 250, h: 180 });
  });

  it("un voisin collé au bord droit arrête le glisser : la place visée est occupée", () => {
    // Cible 1200 ramenée au bord droit (750), qui est exactement le voisin 750…1000 : on s'arrête au bord proche.
    const autre = place({ id: "b", x: 750, l: 250 });
    const r = deplacerLibre({ p: place({ l: 250 }), x: 1200, y: 0, autres: [autre], largeurPx: 1000 });
    expect(r.x).toBe(500);
    expect(r.x + r.l).toBe(750);
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

  it("s'arrête au bord haut d'un voisin placé en bas à gauche (cas exact de la relecture)", () => {
    // Le voisin croise la largeur du widget (300…600 contre 500…700) sans être à sa droite : grandir h le toucherait.
    const p = place({ x: 500, y: 0, l: 200, h: 90 });
    const autre = place({ id: "b", x: 300, y: 200, l: 300, h: 90 });
    const r = redimensionnerLibre({ p, l: 200, h: 290, min: { l: 100, h: 90 }, max: { l: 500, h: 360 }, autres: [autre] });
    expect(r.h).toBe(200);
    expect(r.y + r.h).toBeLessThanOrEqual(autre.y);
    expect(r.x < autre.x + autre.l && autre.x < r.x + r.l).toBe(true); // les largeurs se croisent bien
  });

  it("ne recule pas dans un voisin à sa gauche en glissant pour le minimum", () => {
    // p = 900…1000, voisin à gauche = 750…850 : reculer pour tenir le minimum (200 ‰) ne doit pas le chevaucher.
    const autre = place({ id: "b", x: 750, y: 0, l: 100, h: 180 });
    const r = redimensionnerLibre({ p: place({ x: 900, l: 100, h: 180 }), l: 200, h: 180, min: { l: 200, h: 90 }, max: { l: 500, h: 360 }, autres: [autre] });
    expect(r.x).toBeGreaterThanOrEqual(autre.x + autre.l);
    expect(r.x + r.l).toBeLessThanOrEqual(LARGEUR_LIBRE);
    expect(r.x < autre.x + autre.l && autre.x < r.x + r.l && r.y < autre.y + autre.h && autre.y < r.y + r.h).toBe(false);
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

  it("rend un guide pour un voisin hors grille, à un pas d'aimantation près", () => {
    // Voisin à 333 ‰, aperçu aimanté à 335 ‰ : 2 px d'écart, sous le pas de 5 ‰ (5 px pour 1000 px).
    const r = guidesLibres({ p: place({ x: 335 }), autres: [place({ id: "b", x: 333, y: 300 })], largeurPx: 1000 });
    expect(r.x).toContain(335);
  });
});
