import { expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { cheminsEspace } from "../../src/chemins.js";
import { lireDispositionLibre, placerManquantsLibre } from "../../src/accueil/lire.js";
import { taillesLibres, type PlacementLibre } from "../../src/accueil/schemas.js";
import { dossierTemporaire } from "../aide/temporaire.js";

async function espace() {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.accueil, { recursive: true });
  return c;
}

test("taillesLibres convertit 3 × 2 unités en 250 ‰ × 180 px", () => {
  expect(taillesLibres({ l: 3, h: 2 })).toEqual({ l: 250, h: 180 });
});

test("lireDispositionLibre lit la version 3 et rend [] pour la version 2, un fichier abîmé ou un chevauchement", async () => {
  const c = await espace();
  const widgets = [
    { id: "a", x: 0, y: 0, l: 500, h: 90 },
    { id: "b", x: 500, y: 0, l: 500, h: 90 },
  ];
  await writeFile(c.disposition, JSON.stringify({ version: 3, widgets }));
  expect(await lireDispositionLibre(c)).toEqual(widgets);

  await writeFile(c.disposition, JSON.stringify({ version: 2, widgets }));
  expect(await lireDispositionLibre(c)).toEqual([]);

  await writeFile(c.disposition, "{ pas du json");
  expect(await lireDispositionLibre(c)).toEqual([]);

  await writeFile(
    c.disposition,
    JSON.stringify({ version: 3, widgets: [{ id: "a", x: 400, y: 0, l: 500, h: 90 }, { id: "b", x: 500, y: 0, l: 500, h: 90 }] }),
  );
  expect(await lireDispositionLibre(c)).toEqual([]);
});

test("placerManquantsLibre garde un placement voulu valide et ignore un id inconnu ou un doublon", () => {
  const defauts = new Map([["a", { l: 500, h: 90 }]]);
  const voulus: PlacementLibre[] = [
    { id: "a", x: 500, y: 0, l: 500, h: 90 },
    { id: "fantome", x: 0, y: 0, l: 500, h: 90 },
    { id: "a", x: 0, y: 0, l: 500, h: 90 },
  ];
  expect(placerManquantsLibre(["a"], voulus, defauts)).toEqual([{ id: "a", x: 500, y: 0, l: 500, h: 90 }]);
});

test("placerManquantsLibre pose les widgets sans position au premier trou, sans chevauchement", () => {
  const defauts = new Map([
    ["a", { l: 500, h: 90 }],
    ["b", { l: 500, h: 90 }],
  ]);
  expect(placerManquantsLibre(["a", "b"], [], defauts)).toEqual([
    { id: "a", x: 0, y: 0, l: 500, h: 90 },
    { id: "b", x: 500, y: 0, l: 500, h: 90 },
  ]);
});

test("placerManquantsLibre place en dessous quand la rangée est pleine", () => {
  const defauts = new Map([
    ["a", { l: 500, h: 90 }],
    ["b", { l: 500, h: 90 }],
    ["c", { l: 500, h: 90 }],
  ]);
  expect(placerManquantsLibre(["a", "b", "c"], [], defauts)).toEqual([
    { id: "a", x: 0, y: 0, l: 500, h: 90 },
    { id: "b", x: 500, y: 0, l: 500, h: 90 },
    { id: "c", x: 0, y: 90, l: 500, h: 90 },
  ]);
});

test("placerManquantsLibre pose un widget dans le trou au bord droit d'un voisin", () => {
  // a = 0…250, b = 500…750 : le trou commence exactement à 250, hors des pas de 8 ‰.
  const defauts = new Map([
    ["a", { l: 250, h: 180 }],
    ["b", { l: 250, h: 180 }],
    ["nouveau", { l: 250, h: 180 }],
  ]);
  const voulus = [
    { id: "a", x: 0, y: 0, l: 250, h: 180 },
    { id: "b", x: 500, y: 0, l: 250, h: 180 },
  ];
  expect(placerManquantsLibre(["a", "b", "nouveau"], voulus, defauts)).toEqual([
    ...voulus,
    { id: "nouveau", x: 250, y: 0, l: 250, h: 180 },
  ]);
});
