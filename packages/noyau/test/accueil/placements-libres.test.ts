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

test("taillesLibres converts 3 × 2 units to 250 ‰ × 180 px", () => {
  expect(taillesLibres({ l: 3, h: 2 })).toEqual({ l: 250, h: 180 });
});

test("lireDispositionLibre reads version 3 and returns [] for version 2, a damaged file or an overlap", async () => {
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

test("placerManquantsLibre keeps a valid wanted placement and ignores an unknown id or a duplicate", () => {
  const defauts = new Map([["a", { l: 500, h: 90 }]]);
  const voulus: PlacementLibre[] = [
    { id: "a", x: 500, y: 0, l: 500, h: 90 },
    { id: "fantome", x: 0, y: 0, l: 500, h: 90 },
    { id: "a", x: 0, y: 0, l: 500, h: 90 },
  ];
  expect(placerManquantsLibre(["a"], voulus, defauts)).toEqual([{ id: "a", x: 500, y: 0, l: 500, h: 90 }]);
});

test("placerManquantsLibre puts widgets without a position at the first gap, without overlap", () => {
  const defauts = new Map([
    ["a", { l: 500, h: 90 }],
    ["b", { l: 500, h: 90 }],
  ]);
  expect(placerManquantsLibre(["a", "b"], [], defauts)).toEqual([
    { id: "a", x: 0, y: 0, l: 500, h: 90 },
    { id: "b", x: 500, y: 0, l: 500, h: 90 },
  ]);
});

test("placerManquantsLibre places below when the row is full", () => {
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

test("placerManquantsLibre puts a widget in the gap at a neighbor's right edge", () => {
  // a = 0…250, b = 500…750: the gap starts exactly at 250, off the 8 ‰ steps.
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
