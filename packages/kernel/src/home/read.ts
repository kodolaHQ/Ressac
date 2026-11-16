import { say } from "../i18n.js";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import type { SpacePaths } from "../paths.js";
import { readData, readWidgetState } from "./data.js";
import {
  DeclarationWidget,
  FreeLayout,
  FREE_WIDTH,
  FreePlacement,
  type HomeState,
  type WidgetRead,
} from "./schemas.js";

const ID_WIDGET = /^[a-z0-9-]+$/;

/** Reads a JSON of the workspace, refusing a symbolic link that would leave the widget's folder. */
async function readJsonIn(folder: string, name: string): Promise<unknown> {
  const [root, real] = await Promise.all([realpath(folder), realpath(join(folder, name))]);
  if (!real.startsWith(root + sep)) throw new Error(`${name} sort du dossier du widget`);
  return JSON.parse(await readFile(real, "utf8"));
}

async function readWidget(c: SpacePaths, widgetsFolder: string, id: string, locale: string, withData = true): Promise<WidgetRead> {
  const folder = join(c.widgets, id);
  let declaration: DeclarationWidget;
  try {
    declaration = DeclarationWidget.parse(await readJsonIn(folder, "widget.json"));
  } catch (e) {
    return { id, folder: folder, error: say(locale, "kernel-widget-invalid", { error: (e as Error).message }) };
  }
  let example: unknown | null = null;
  try {
    example = await readJsonIn(folder, "example.json");
  } catch {
    // example.json absent or damaged: no example.
  }
  const [data, state] = await Promise.all([withData ? readData(widgetsFolder, id) : null, readWidgetState(widgetsFolder, id)]);
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

type Rectangle = { x: number; y: number; w: number; h: number };

const overlaps = (a: Rectangle, b: Rectangle) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const STEP_X = 8;
const STEP_Y = 8;

/**
 * The x values tried: 0, the right edge of each placed widget (a gap can start exactly there, off the 8 ‰ steps),
 * then the 8 ‰ steps and the last x flush with the edge.
 */
function freeXs(busy: Rectangle[], xMax: number): number[] {
  const xs = new Set<number>([0, xMax]);
  for (let x = STEP_X; x < xMax; x += STEP_X) xs.add(x);
  for (const o of busy) if (o.x + o.w <= xMax) xs.add(o.x + o.w);
  return [...xs].sort((a, b) => a - b);
}

/** First free spot in free units: the x values above, and for y 0, the bottoms of placed widgets, then the 8 px steps. */
function firstFreeSlot(busy: Rectangle[], w: number, h: number): { x: number; y: number } {
  const xMax = FREE_WIDTH - w;
  const xs = freeXs(busy, xMax);
  for (let y = 0; ; ) {
    for (const x of xs) {
      if (!busy.some((o) => overlaps(o, { x, y, w, h }))) return { x, y };
    }
    // A widget's bottom can fall between two steps (90 px high, y = 90): try it too.
    const bottom = busy.map((o) => o.y + o.h).filter((b) => b > y);
    y = bottom.length > 0 ? Math.min(y + STEP_Y, ...bottom) : y + STEP_Y;
  }
}

/** Placements of layout.json in free units. Another version, a damaged file or an overlap gives []. */
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
 * Placement in free units: a valid wanted placement is kept, an unknown id or a
 * duplicate is ignored, and each missing widget is put at the first hole with no overlap.
 */
export function placeMissingFree(
  ids: readonly string[],
  wanted: readonly FreePlacement[],
  defaults: ReadonlyMap<string, { w: number; h: number }>,
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
    const { w, h } = old ?? defaults.get(id)!;
    kept.push({ id, ...firstFreeSlot(kept, w, h), w, h });
  }
  return kept;
}

/** One widget of the home page, without reading the others (undefined: no such widget folder). */
export async function readOneWidget(c: SpacePaths, widgetsFolder: string, id: string, locale = "en"): Promise<WidgetRead | undefined> {
  // lstat, as readHome's readdir: a link named like a widget is not one.
  if (!ID_WIDGET.test(id) || !(await lstat(join(c.widgets, id)).then((s) => s.isDirectory(), () => false))) return undefined;
  return readWidget(c, widgetsFolder, id, locale);
}

/** Reads the home page. A broken widget is reported, it does not prevent reading the others. */
/** `withData` false: every `data` is null, for a caller that never shows it (a data.json is up to 2 MB to parse). */
export async function readHome(c: SpacePaths, widgetsFolder: string, locale = "en", withData = true): Promise<HomeState> {
  if (!existsSync(c.widgets)) return { widgets: [] };
  const ids = (await readdir(c.widgets, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && ID_WIDGET.test(e.name))
    .map((e) => e.name)
    .sort();
  return { widgets: await Promise.all(ids.map((id) => readWidget(c, widgetsFolder, id, locale, withData))) };
}
