import { readdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import type { CheminsEspace } from "../chemins.js";
import { lireDonnees, lireEtatWidget } from "./donnees.js";
import {
  COLONNES,
  DeclarationWidget,
  DispositionLibre,
  LARGEUR_LIBRE,
  Placement,
  PlacementLibre,
  type EtatAccueil,
  type WidgetLu,
} from "./schemas.js";

const ID_WIDGET = /^[a-z0-9-]+$/;

/** Reads a JSON of the workspace, refusing a symbolic link that would leave the widget's folder. */
async function lireJsonDans(dossier: string, nom: string): Promise<unknown> {
  const [racine, reel] = await Promise.all([realpath(dossier), realpath(join(dossier, nom))]);
  if (!reel.startsWith(racine + sep)) throw new Error(`${nom} sort du dossier du widget`);
  return JSON.parse(await readFile(reel, "utf8"));
}

async function lireWidget(c: CheminsEspace, dossierWidgets: string, id: string): Promise<WidgetLu> {
  const dossier = join(c.widgets, id);
  let declaration: DeclarationWidget;
  try {
    declaration = DeclarationWidget.parse(await lireJsonDans(dossier, "widget.json"));
  } catch (e) {
    return { id, dossier, erreur: `widget.json invalide : ${(e as Error).message}` };
  }
  let exemple: unknown | null = null;
  try {
    exemple = await lireJsonDans(dossier, "exemple.json");
  } catch {
    // exemple.json absent or damaged: no example.
  }
  const [donnees, etat] = await Promise.all([lireDonnees(dossierWidgets, id), lireEtatWidget(dossierWidgets, id)]);
  const aWorkflow = existsSync(join(dossier, "workflow.json"));
  return {
    id,
    dossier,
    declaration,
    etat,
    donnees,
    exemple,
    aRecolte: aWorkflow || existsSync(join(dossier, "recolte.mjs")),
    aWorkflow,
    aAffichage: existsSync(join(dossier, "affichage.html")),
  };
}

/** Readable placements of disposition.json. The old format (`{ ordre }`) or a damaged file gives []. */
async function lirePlacements(c: CheminsEspace): Promise<Placement[]> {
  try {
    const brut = JSON.parse(await readFile(c.disposition, "utf8")) as { version?: unknown; widgets?: unknown };
    if (brut.version !== 2 || !Array.isArray(brut.widgets)) return [];
    return brut.widgets.flatMap((w) => {
      const p = Placement.safeParse(w);
      return p.success ? [p.data] : [];
    });
  } catch {
    return [];
  }
}

type Rectangle = { x: number; y: number; l: number; h: number };

const chevauche = (a: Rectangle, b: Rectangle) => a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.h && b.y < a.y + a.h;

/** First free spot: rows from top to bottom, then columns left to right. */
function premierePlace(occupes: Rectangle[], l: number, h: number): { x: number; y: number } {
  for (let y = 0; ; y++) {
    for (let x = 0; x + l <= COLONNES; x++) {
      if (!occupes.some((o) => chevauche(o, { x, y, l, h }))) return { x, y };
    }
  }
}

/**
 * Places each widget present on disk. A valid placement is kept; a widget with no
 * placement, or whose placement overlaps another, is put at the first free spot.
 */
export function placerManquants(ids: string[], voulus: Placement[], defauts: Map<string, { l: number; h: number }>): Placement[] {
  const retenus: Placement[] = [];
  const dejaVus = new Set<string>();
  for (const p of voulus) {
    if (!defauts.has(p.id) || dejaVus.has(p.id)) continue; // unknown id or duplicate: ignored
    dejaVus.add(p.id);
    if (!retenus.some((r) => chevauche(r, p))) retenus.push(p);
  }
  const aPlacer = [...voulus.map((p) => p.id), ...ids].filter((id, i, tous) => defauts.has(id) && tous.indexOf(id) === i && !retenus.some((r) => r.id === id));
  for (const id of aPlacer) {
    const ancien = voulus.find((p) => p.id === id);
    const { l, h } = ancien ?? defauts.get(id)!;
    retenus.push({ id, ...premierePlace(retenus, l, h), l, h });
  }
  return retenus;
}

const PAS_X = 8;
const PAS_Y = 8;

/**
 * The x values tried: 0, the right edge of each placed widget (a gap can start exactly there, off the 8 ‰ steps),
 * then the 8 ‰ steps and the last x flush with the edge.
 */
function abscissesLibres(occupes: Rectangle[], xMax: number): number[] {
  const xs = new Set<number>([0, xMax]);
  for (let x = PAS_X; x < xMax; x += PAS_X) xs.add(x);
  for (const o of occupes) if (o.x + o.l <= xMax) xs.add(o.x + o.l);
  return [...xs].sort((a, b) => a - b);
}

/** First free spot in free units: the x values above, and for y 0, the bottoms of placed widgets, then the 8 px steps. */
function premierePlaceLibre(occupes: Rectangle[], l: number, h: number): { x: number; y: number } {
  const xMax = LARGEUR_LIBRE - l;
  const xs = abscissesLibres(occupes, xMax);
  for (let y = 0; ; ) {
    for (const x of xs) {
      if (!occupes.some((o) => chevauche(o, { x, y, l, h }))) return { x, y };
    }
    // A widget's bottom can fall between two steps (90 px high, y = 90): try it too.
    const bas = occupes.map((o) => o.y + o.h).filter((b) => b > y);
    y = bas.length > 0 ? Math.min(y + PAS_Y, ...bas) : y + PAS_Y;
  }
}

/** Placements of disposition.json in free units. Another version, a damaged file or an overlap gives []. */
export async function lireDispositionLibre(c: CheminsEspace): Promise<PlacementLibre[]> {
  try {
    const dispo = DispositionLibre.safeParse(JSON.parse(await readFile(c.disposition, "utf8")));
    if (!dispo.success) return [];
    const { widgets } = dispo.data;
    if (widgets.some((a, i) => widgets.slice(i + 1).some((b) => chevauche(a, b)))) return [];
    return widgets;
  } catch {
    return [];
  }
}

/**
 * Same contract as placerManquants, in free units: a valid wanted placement is kept, an unknown id or a
 * duplicate is ignored, and each missing widget is put at the first hole with no overlap.
 */
export function placerManquantsLibre(
  ids: readonly string[],
  voulus: readonly PlacementLibre[],
  defauts: ReadonlyMap<string, { l: number; h: number }>,
): PlacementLibre[] {
  const parses = voulus.flatMap((p) => {
    const v = PlacementLibre.safeParse(p);
    return v.success ? [v.data] : [];
  });
  const retenus: PlacementLibre[] = [];
  const dejaVus = new Set<string>();
  for (const p of parses) {
    if (!defauts.has(p.id) || dejaVus.has(p.id)) continue;
    dejaVus.add(p.id);
    if (!retenus.some((r) => chevauche(r, p))) retenus.push(p);
  }
  const aPlacer = [...parses.map((p) => p.id), ...ids].filter((id, i, tous) => defauts.has(id) && tous.indexOf(id) === i && !retenus.some((r) => r.id === id));
  for (const id of aPlacer) {
    const ancien = parses.find((p) => p.id === id);
    const { l, h } = ancien ?? defauts.get(id)!;
    retenus.push({ id, ...premierePlaceLibre(retenus, l, h), l, h });
  }
  return retenus;
}

/** Reads the home page. A broken widget is reported, it does not prevent reading the others. */
export async function lireAccueil(c: CheminsEspace, dossierWidgets: string): Promise<EtatAccueil> {
  if (!existsSync(c.widgets)) return { disposition: [], widgets: [] };
  const ids = (await readdir(c.widgets, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && ID_WIDGET.test(e.name))
    .map((e) => e.name)
    .sort();
  const widgets = await Promise.all(ids.map((id) => lireWidget(c, dossierWidgets, id)));
  // A widget in error has no known size: it is not placed.
  const defauts = new Map(widgets.flatMap((w) => ("declaration" in w ? [[w.id, w.declaration.tailles.defaut] as const] : [])));
  const disposition = placerManquants(ids, await lirePlacements(c), defauts);
  return { disposition, widgets };
}
