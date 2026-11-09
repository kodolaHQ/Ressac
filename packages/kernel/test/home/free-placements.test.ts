import { expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { spacePaths } from "../../src/paths.js";
import { readFreeLayout, placeMissingFree } from "../../src/home/lire.js";
import { freeSizes, type FreePlacement } from "../../src/home/schemas.js";
import { tempFolder } from "../helpers/temp.js";

async function space() {
  const c = spacePaths(await tempFolder());
  await mkdir(c.accueil, { recursive: true });
  return c;
}

test("freeSizes converts 3 × 2 units to 250 ‰ × 180 px", () => {
  expect(freeSizes({ l: 3, h: 2 })).toEqual({ l: 250, h: 180 });
});

test("lireDispositionLibre reads version 3 and returns [] for version 2, a damaged file or an overlap", async () => {
  const c = await space();
  const widgets = [
    { id: "a", x: 0, y: 0, l: 500, h: 90 },
    { id: "b", x: 500, y: 0, l: 500, h: 90 },
  ];
  await writeFile(c.disposition, JSON.stringify({ version: 3, widgets }));
  expect(await readFreeLayout(c)).toEqual(widgets);

  await writeFile(c.disposition, JSON.stringify({ version: 2, widgets }));
  expect(await readFreeLayout(c)).toEqual([]);

  await writeFile(c.disposition, "{ pas du json");
  expect(await readFreeLayout(c)).toEqual([]);

  await writeFile(
    c.disposition,
    JSON.stringify({ version: 3, widgets: [{ id: "a", x: 400, y: 0, l: 500, h: 90 }, { id: "b", x: 500, y: 0, l: 500, h: 90 }] }),
  );
  expect(await readFreeLayout(c)).toEqual([]);
});

test("placeMissingFree keeps a valid wanted placement and ignores an unknown id or a duplicate", () => {
  const defaults = new Map([["a", { l: 500, h: 90 }]]);
  const wanted: FreePlacement[] = [
    { id: "a", x: 500, y: 0, l: 500, h: 90 },
    { id: "fantome", x: 0, y: 0, l: 500, h: 90 },
    { id: "a", x: 0, y: 0, l: 500, h: 90 },
  ];
  expect(placeMissingFree(["a"], wanted, defaults)).toEqual([{ id: "a", x: 500, y: 0, l: 500, h: 90 }]);
});

test("placeMissingFree puts widgets without a position at the first gap, without overlap", () => {
  const defaults = new Map([
    ["a", { l: 500, h: 90 }],
    ["b", { l: 500, h: 90 }],
  ]);
  expect(placeMissingFree(["a", "b"], [], defaults)).toEqual([
    { id: "a", x: 0, y: 0, l: 500, h: 90 },
    { id: "b", x: 500, y: 0, l: 500, h: 90 },
  ]);
});

test("placeMissingFree places below when the row is full", () => {
  const defaults = new Map([
    ["a", { l: 500, h: 90 }],
    ["b", { l: 500, h: 90 }],
    ["c", { l: 500, h: 90 }],
  ]);
  expect(placeMissingFree(["a", "b", "c"], [], defaults)).toEqual([
    { id: "a", x: 0, y: 0, l: 500, h: 90 },
    { id: "b", x: 500, y: 0, l: 500, h: 90 },
    { id: "c", x: 0, y: 90, l: 500, h: 90 },
  ]);
});

test("placeMissingFree puts a widget in the gap at a neighbor's right edge", () => {
  // a = 0…250, b = 500…750: the gap starts exactly at 250, off the 8 ‰ steps.
  const defaults = new Map([
    ["a", { l: 250, h: 180 }],
    ["b", { l: 250, h: 180 }],
    ["nouveau", { l: 250, h: 180 }],
  ]);
  const wanted = [
    { id: "a", x: 0, y: 0, l: 250, h: 180 },
    { id: "b", x: 500, y: 0, l: 250, h: 180 },
  ];
  expect(placeMissingFree(["a", "b", "nouveau"], wanted, defaults)).toEqual([
    ...wanted,
    { id: "nouveau", x: 250, y: 0, l: 250, h: 180 },
  ]);
});
