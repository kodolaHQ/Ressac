import { readdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import type { SpacePaths } from "../paths.js";
import { readData, readWidgetState } from "./data.js";
import {
  COLUMNS,
  DeclarationWidget,
  FreeLayout,
  FREE_WIDTH,
  Placement,
  FreePlacement,
  type HomeState,
  type WidgetLu,
} from "./schemas.js";

const ID_WIDGET = /^[a-z0-9-]+$/;

/** Reads a JSON of the workspace, refusing a symbolic link that would leave the widget's folder. */
async function readJsonIn(folder: string, name: string): Promise<unknown> {
  const [root, real] = await Promise.all([realpath(folder), realpath(join(folder, name))]);
  if (!real.startsWith(root + sep)) throw new Error(`${name} sort du dossier du widget`);
  return JSON.parse(await readFile(real, "utf8"));
}

async function readWidget(c: SpacePaths, widgetsFolder: string, id: string): Promise<WidgetLu> {
  const folder = join(c.widgets, id);
  let declaration: DeclarationWidget;
  try {
    declaration = DeclarationWidget.parse(await readJsonIn(folder, "widget.json"));
  } catch (e) {
    return { id, folder: folder, error: `widget.json invalide : ${(e as Error).message}` };
  }
  let example: unknown | null = null;
  try {
    example = await readJsonIn(folder, "example.json");
  } catch {
    // example.json absent or damaged: no example.
  }
  const [data, state] = await Promise.all([readData(widgetsFolder, id), readWidgetState(widgetsFolder, id)]);
  const hasWorkflow = existsSync(join(folder, "workflow.json"));
  return {
    id,
    folder: folder,
    declaration,
    state: state,
    data: data,
    example: example,
    hasHarvest: hasWorkflow || existsSync(join(folder, "harvest.mjs")),
    hasWorkflow,
    hasDisplay: existsSync(join(folder, "display.html")),
  };
}

/** Readable placements of disposition.json. The old format (`{ ordre }`) or a damaged file gives []. */
async function readPlacements(c: SpacePaths): Promise<Placement[]> {
  try {
    const raw = JSON.parse(await readFile(c.layout, "utf8")) as { version?: unknown; widgets?: unknown };
    if (raw.version !== 2 || !Array.isArray(raw.widgets)) return [];
    return raw.widgets.flatMap((w) => {
      const p = Placement.safeParse(w);
      return p.success ? [p.data] : [];
    });
  } catch {
    return [];
  }
}

type Rectangle = { x: number; y: number; l: number; h: number };

const overlaps = (a: Rectangle, b: Rectangle) => a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.h && b.y < a.y + a.h;

/** First free spot: rows from top to bottom, then columns left to right. */
function firstPlace(busy: Rectangle[], l: number, h: number): { x: number; y: number } {
  for (let y = 0; ; y++) {
    for (let x = 0; x + l <= COLUMNS; x++) {
      if (!busy.some((o) => overlaps(o, { x, y, l, h }))) return { x, y };
    }
  }
}

/**
 * Places each widget present on disk. A valid placement is kept; a widget with no
 * placement, or whose placement overlaps another, is put at the first free spot.
 */
export function placeMissing(ids: string[], wanted: Placement[], defaults: Map<string, { l: number; h: number }>): Placement[] {
  const kept: Placement[] = [];
  const alreadySeen = new Set<string>();
  for (const p of wanted) {
    if (!defaults.has(p.id) || alreadySeen.has(p.id)) continue; // unknown id or duplicate: ignored
    alreadySeen.add(p.id);
    if (!kept.some((r) => overlaps(r, p))) kept.push(p);
  }
  const toPlace = [...wanted.map((p) => p.id), ...ids].filter((id, i, all) => defaults.has(id) && all.indexOf(id) === i && !kept.some((r) => r.id === id));
  for (const id of toPlace) {
    const old = wanted.find((p) => p.id === id);
    const { l, h } = old ?? defaults.get(id)!;
    kept.push({ id, ...firstPlace(kept, l, h), l, h });
  }
  return kept;
}

const STEP_X = 8;
const STEP_Y = 8;

/**
 * The x values tried: 0, the right edge of each placed widget (a gap can start exactly there, off the 8 ‰ steps),
 * then the 8 ‰ steps and the last x flush with the edge.
 */
function freeXs(busy: Rectangle[], xMax: number): number[] {
  const xs = new Set<number>([0, xMax]);
  for (let x = STEP_X; x < xMax; x += STEP_X) xs.add(x);
  for (const o of busy) if (o.x + o.l <= xMax) xs.add(o.x + o.l);
  return [...xs].sort((a, b) => a - b);
}

/** First free spot in free units: the x values above, and for y 0, the bottoms of placed widgets, then the 8 px steps. */
function firstFreeSlot(busy: Rectangle[], l: number, h: number): { x: number; y: number } {
  const xMax = FREE_WIDTH - l;
  const xs = freeXs(busy, xMax);
  for (let y = 0; ; ) {
    for (const x of xs) {
      if (!busy.some((o) => overlaps(o, { x, y, l, h }))) return { x, y };
    }
    // A widget's bottom can fall between two steps (90 px high, y = 90): try it too.
    const bottom = busy.map((o) => o.y + o.h).filter((b) => b > y);
    y = bottom.length > 0 ? Math.min(y + STEP_Y, ...bottom) : y + STEP_Y;
  }
}

/** Placements of disposition.json in free units. Another version, a damaged file or an overlap gives []. */
export async function readFreeLayout(c: SpacePaths): Promise<FreePlacement[]> {
  try {
    const available = FreeLayout.safeParse(JSON.parse(await readFile(c.layout, "utf8")));
    if (!available.success) return [];
    const { widgets } = available.data;
    if (widgets.some((a, i) => widgets.slice(i + 1).some((b) => overlaps(a, b)))) return [];
    return widgets;
  } catch {
    return [];
  }
}

/**
 * Same contract as placerManquants, in free units: a valid wanted placement is kept, an unknown id or a
 * duplicate is ignored, and each missing widget is put at the first hole with no overlap.
 */
export function placeMissingFree(
  ids: readonly string[],
  wanted: readonly FreePlacement[],
  defaults: ReadonlyMap<string, { l: number; h: number }>,
): FreePlacement[] {
  const parses = wanted.flatMap((p) => {
    const v = FreePlacement.safeParse(p);
    return v.success ? [v.data] : [];
  });
  const kept: FreePlacement[] = [];
  const alreadySeen = new Set<string>();
  for (const p of parses) {
    if (!defaults.has(p.id) || alreadySeen.has(p.id)) continue;
    alreadySeen.add(p.id);
    if (!kept.some((r) => overlaps(r, p))) kept.push(p);
  }
  const toPlace = [...parses.map((p) => p.id), ...ids].filter((id, i, all) => defaults.has(id) && all.indexOf(id) === i && !kept.some((r) => r.id === id));
  for (const id of toPlace) {
    const old = parses.find((p) => p.id === id);
    const { l, h } = old ?? defaults.get(id)!;
    kept.push({ id, ...firstFreeSlot(kept, l, h), l, h });
  }
  return kept;
}

/** Reads the home page. A broken widget is reported, it does not prevent reading the others. */
export async function readHome(c: SpacePaths, widgetsFolder: string): Promise<HomeState> {
  if (!existsSync(c.widgets)) return { layout: [], widgets: [] };
  const ids = (await readdir(c.widgets, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && ID_WIDGET.test(e.name))
    .map((e) => e.name)
    .sort();
  const widgets = await Promise.all(ids.map((id) => readWidget(c, widgetsFolder, id)));
  // A widget in error has no known size: it is not placed.
  const defaults = new Map(widgets.flatMap((w) => ("declaration" in w ? [[w.id, w.declaration.sizes.default] as const] : [])));
  const layout = placeMissing(ids, await readPlacements(c), defaults);
  return { layout: layout, widgets };
}
