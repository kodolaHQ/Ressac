import { expect, test } from "vitest";
import { DELAI_GESTE_MS, gardienGestes } from "../../src/main/agent/geste-widget";

const cadre = { x: 50, y: 100, largeur: 300, hauteur: 200 };

function horloge() {
  const h = { t: 10_000, maintenant: () => h.t };
  return h;
}

test("sans clic réel, aucun lien (chargement, minuterie, focus forcé)", () => {
  const g = gardienGestes(horloge().maintenant);
  expect(g.accepter("f1", cadre)).toBe(false);
});

test("un clic réel dans le cadre permet un lien, un seul", () => {
  const h = horloge();
  const g = gardienGestes(h.maintenant);
  g.clic("f1", 100, 150);
  h.t += 400;
  expect(g.accepter("f1", cadre)).toBe(true);
  expect(g.accepter("f1", cadre)).toBe(false);
});

test("un clic hors du cadre (bords exclus) ne permet rien, et reste pour le bon cadre", () => {
  const g = gardienGestes(horloge().maintenant);
  g.clic("f1", 10, 10);
  expect(g.accepter("f1", cadre)).toBe(false);
  g.clic("f1", 350, 150); // bord droit : hors du cadre
  expect(g.accepter("f1", cadre)).toBe(false);
  // Un autre widget qui demande un lien n'use pas le clic : le widget cliqué peut encore ouvrir le sien.
  g.clic("f1", 360, 150);
  expect(g.accepter("f1", cadre)).toBe(false);
  expect(g.accepter("f1", { x: 355, y: 100, largeur: 100, hauteur: 100 })).toBe(true);
});

test("le clic d'une autre fenêtre ne compte pas", () => {
  const g = gardienGestes(horloge().maintenant);
  g.clic("f2", 100, 150);
  expect(g.accepter("f1", cadre)).toBe(false);
  expect(g.accepter("f2", cadre)).toBe(true);
});

test("le clic expire après le délai (appui long compris jusqu'à 1,5 s)", () => {
  const h = horloge();
  const g = gardienGestes(h.maintenant);
  expect(DELAI_GESTE_MS).toBe(1500);
  g.clic("f1", 100, 150);
  h.t += 1400;
  expect(g.accepter("f1", cadre)).toBe(true);
  g.clic("f1", 100, 150);
  h.t += 1600;
  expect(g.accepter("f1", cadre)).toBe(false);
});

test("seul le dernier clic compte", () => {
  const g = gardienGestes(horloge().maintenant);
  g.clic("f1", 100, 150);
  g.clic("f1", 10, 10);
  expect(g.accepter("f1", cadre)).toBe(false);
});
