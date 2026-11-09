import { expect, test } from "vitest";
import { rectCapture } from "../../core/design/viseur";

test("rectCapture : marge de 16 de chaque côté, bornée à la vue", () => {
  expect(rectCapture({ x: 10, y: 10, largeur: 100, hauteur: 20 }, { largeur: 800, hauteur: 600 }, 1)).toEqual({ x: 0, y: 0, width: 126, height: 46 });
});

test("rectCapture : le zoom double tout puis borne à 1600×1200", () => {
  expect(rectCapture({ x: 10, y: 10, largeur: 100, hauteur: 20 }, { largeur: 800, hauteur: 600 }, 2)).toEqual({ x: 4, y: 4, width: 232, height: 72 });
  expect(rectCapture({ x: 0, y: 0, largeur: 900, hauteur: 700 }, { largeur: 800, hauteur: 600 }, 2)).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
});

test("rectCapture : un élément au bord bas-droit est borné à la vue", () => {
  expect(rectCapture({ x: 700, y: 560, largeur: 100, hauteur: 40 }, { largeur: 800, hauteur: 600 }, 1)).toEqual({ x: 684, y: 544, width: 116, height: 56 });
});

test("rectCapture : décalé de la place du cadre dans sa page, après le bornage à la vue du cadre", () => {
  expect(rectCapture({ x: 0, y: 0, largeur: 50, hauteur: 20 }, { largeur: 800, hauteur: 600 }, 1, { x: 10, y: 36 })).toEqual({ x: 10, y: 36, width: 66, height: 36 });
});
