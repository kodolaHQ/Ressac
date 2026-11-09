import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ID_EXECUTION,
  readFreeLayout,
  readRun,
  listRuns,
  placeMissingFree,
  FreePlacement,
  freeSizes,
  type SpacePaths,
  type HomeState,
  type Execution,
  type ResumeExecution,
  type HomeTheme,
} from "../../../packages/kernel/src/index.ts";
import type { ShownWidget } from "../shared/api.ts";

// The home page's widgets: free placement (version 3) and the theme.

const ID_WIDGET = /^[a-z0-9-]+$/;
/** The frame's URL: the sanitized copy that the sidebar writes, dated with the source's mtime (a new mtime reloads). */
function displayUrl(id: string, mtime: number): string {
  return `resource://webaios-widget-${id}/display-${mtime}.html`;
}
/** Size given to an unreadable widget (without declaration), so that it keeps a place and shows its error. */
const UNREADABLE_WIDGET_SIZE = { w: 4, h: 2 };

/**
 * What the UI displays: each widget in its place, with its data, its example and its state. `placements`: what
 * layout.json says; absent widgets are placed in the first gap. `mtimes`: date of display.html per widget,
 * to force the frame to reload when the agent rewrites it.
 */
export function toShownWidgets(o: {
  state: HomeState;
  placements: FreePlacement[];
  theme: HomeTheme | null;
  mtimes: Record<string, number>;
}): { widgets: ShownWidget[]; theme: HomeTheme | null } {
  const defaults = new Map(o.state.widgets.map((w) => [w.id, freeSizes("declaration" in w ? w.declaration.sizes.default : UNREADABLE_WIDGET_SIZE)] as const));
  const placements = placeMissingFree(
    o.state.widgets.map((w) => w.id),
    o.placements,
    defaults,
  );
  const widgets = placements.flatMap((placement): ShownWidget[] => {
    const w = o.state.widgets.find((x) => x.id === placement.id);
    if (!w) return [];
    if ("error" in w) return [{ id: w.id, error: w.error, placement }];
    return [
      {
        id: w.id,
        name: w.declaration.name,
        placement,
        sizes: w.declaration.sizes,
        src: w.hasDisplay ? displayUrl(w.id, o.mtimes[w.id] ?? 0) : null,
        data: w.data,
        example: w.example,
        state: w.state,
        account: w.declaration.sources.account,
        public: w.declaration.sources.public,
        hasHarvest: w.hasHarvest,
        hours: w.declaration.harvest?.hours ?? [],
        minutes: w.declaration.harvest?.minutes ?? null,
      },
    ];
  });
  return { widgets, theme: o.theme };
}

/**
 * A layout sent by the UI: integers, within the home, a known widget, only once, without
 * overlap. Refused as a whole otherwise (the UI then re-reads the old layout): `lireDispositionLibre`
 * returns [] for an overlapping layout, and writing it would erase the whole placement at the next read.
 */
export function validatePlacements(raw: unknown, ids: readonly string[]): FreePlacement[] {
  if (!Array.isArray(raw)) throw new Error("placements invalides : liste attendue");
  const known = new Set(ids);
  const placements = raw.map((p) => {
    const r = FreePlacement.safeParse(p);
    if (!r.success) throw new Error(`placements invalides : ${r.error.message}`);
    if (!known.has(r.data.id)) throw new Error(`widget inconnu : ${r.data.id}`);
    return r.data;
  });
  const seen = new Set<string>();
  for (const p of placements) {
    if (seen.has(p.id)) throw new Error(`widget placé deux fois : ${p.id}`);
    seen.add(p.id);
  }
  for (let i = 0; i < placements.length; i++) {
    const a = placements[i]!;
    for (let j = i + 1; j < placements.length; j++) {
      const b = placements[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        throw new Error(`widgets qui se chevauchent : ${a.id} et ${b.id}`);
    }
  }
  return placements;
}

/** Writes to layout.json one by one, in request order: none reads the state another is about to change. */
const layoutQueue = new Map<string, Promise<void>>();
function inSeries(c: SpacePaths, write: () => Promise<void>): Promise<void> {
  const next = (layoutQueue.get(c.layout) ?? Promise.resolve()).then(write);
  const end = next.catch(() => {});
  layoutQueue.set(c.layout, end);
  void end.then(() => layoutQueue.get(c.layout) === end && layoutQueue.delete(c.layout));
  return next;
}

async function writeLayout(c: SpacePaths, widgets: readonly FreePlacement[]): Promise<void> {
  await mkdir(c.home, { recursive: true });
  const temp = `${c.layout}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 3, widgets }, null, 2));
  await rename(temp, c.layout);
}

/** The new layout, already validated: atomic write, in series (two close drags are not lost). */
export function placeWidgets(c: SpacePaths, placements: readonly FreePlacement[]): Promise<void> {
  return inSeries(c, () => writeLayout(c, placements));
}

/**
 * The user removes a widget: its folder goes to accueil/.trash (nothing is destroyed), its place is freed and
 * `oublier` removes its grant and its data (a widget recreated under the same id must not inherit the grant).
 */
export async function removeWidget(c: SpacePaths, id: string, forget: (id: string) => Promise<void>): Promise<void> {
  if (!ID_WIDGET.test(id)) throw new Error(`id de widget invalide : ${id}`);
  await inSeries(c, async () => {
    const remaining = (await readFreeLayout(c)).filter((p) => p.id !== id);
    const trash = join(c.home, ".trash");
    await mkdir(trash, { recursive: true });
    await rename(join(c.widgets, id), join(trash, `${id}-${Date.now()}`));
    await writeLayout(c, remaining);
  });
  await forget(id);
}

/** The kept executions of a widget (`<dossierWidgets>/<id>`), outside the space; nothing for an invalid id. */
export async function executionsWidget(widgetsFolder: string, id: string): Promise<ResumeExecution[]> {
  if (!ID_WIDGET.test(id)) return [];
  return listRuns(join(widgetsFolder, id));
}

/** An execution of a widget; null if one of the two ids is invalid (never a path) or if it no longer exists. */
export async function executionWidget(widgetsFolder: string, id: string, execution: string): Promise<Execution | null> {
  if (!ID_WIDGET.test(id) || !ID_EXECUTION.test(execution)) return null;
  return readRun(join(widgetsFolder, id), execution);
}
