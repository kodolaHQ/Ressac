import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ID_EXECUTION,
  readFreeLayout,
  lireExecution,
  listerExecutions,
  placeMissingFree,
  FreePlacement,
  freeSizes,
  type SpacePaths,
  type HomeState,
  type Execution,
  type ResumeExecution,
  type HomeTheme,
} from "../../../packages/noyau/src/index.ts";
import type { WidgetAffiche } from "../shared/api.ts";

// The home page's widgets: free placement (version 3) and the theme.

const ID_WIDGET = /^[a-z0-9-]+$/;
/** The frame's URL: the sanitized copy that the sidebar writes, dated with the source's mtime (a new mtime reloads). */
function urlAffichage(id: string, mtime: number): string {
  return `resource://webaios-widget-${id}/affichage-${mtime}.html`;
}
/** Size given to an unreadable widget (without declaration), so that it keeps a place and shows its error. */
const TAILLE_WIDGET_ILLISIBLE = { l: 4, h: 2 };

/**
 * What the UI displays: each widget in its place, with its data, its example and its state. `placements`: what
 * disposition.json says; absent widgets are placed in the first gap. `mtimes`: date of affichage.html per widget,
 * to force the frame to reload when the agent rewrites it.
 */
export function versWidgetsAffiches(o: {
  etat: HomeState;
  placements: FreePlacement[];
  theme: HomeTheme | null;
  mtimes: Record<string, number>;
}): { widgets: WidgetAffiche[]; theme: HomeTheme | null } {
  const defauts = new Map(o.etat.widgets.map((w) => [w.id, freeSizes("declaration" in w ? w.declaration.tailles.defaut : TAILLE_WIDGET_ILLISIBLE)] as const));
  const placements = placeMissingFree(
    o.etat.widgets.map((w) => w.id),
    o.placements,
    defauts,
  );
  const widgets = placements.flatMap((placement): WidgetAffiche[] => {
    const w = o.etat.widgets.find((x) => x.id === placement.id);
    if (!w) return [];
    if ("erreur" in w) return [{ id: w.id, erreur: w.erreur, placement }];
    return [
      {
        id: w.id,
        nom: w.declaration.nom,
        placement,
        tailles: w.declaration.tailles,
        src: w.aAffichage ? urlAffichage(w.id, o.mtimes[w.id] ?? 0) : null,
        donnees: w.donnees,
        exemple: w.exemple,
        etat: w.etat,
        compte: w.declaration.sources.compte,
        publiques: w.declaration.sources.publiques,
        aRecolte: w.aRecolte,
        heures: w.declaration.recolte?.heures ?? [],
        minutes: w.declaration.recolte?.minutes ?? null,
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
export function validerPlacements(brut: unknown, ids: readonly string[]): FreePlacement[] {
  if (!Array.isArray(brut)) throw new Error("placements invalides : liste attendue");
  const connus = new Set(ids);
  const placements = brut.map((p) => {
    const r = FreePlacement.safeParse(p);
    if (!r.success) throw new Error(`placements invalides : ${r.error.message}`);
    if (!connus.has(r.data.id)) throw new Error(`widget inconnu : ${r.data.id}`);
    return r.data;
  });
  const vus = new Set<string>();
  for (const p of placements) {
    if (vus.has(p.id)) throw new Error(`widget placé deux fois : ${p.id}`);
    vus.add(p.id);
  }
  for (let i = 0; i < placements.length; i++) {
    const a = placements[i]!;
    for (let j = i + 1; j < placements.length; j++) {
      const b = placements[j]!;
      if (a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.h && b.y < a.y + a.h)
        throw new Error(`widgets qui se chevauchent : ${a.id} et ${b.id}`);
    }
  }
  return placements;
}

/** Writes to disposition.json one by one, in request order: none reads the state another is about to change. */
const fileDisposition = new Map<string, Promise<void>>();
function enSerie(c: SpacePaths, ecrire: () => Promise<void>): Promise<void> {
  const suite = (fileDisposition.get(c.disposition) ?? Promise.resolve()).then(ecrire);
  const fin = suite.catch(() => {});
  fileDisposition.set(c.disposition, fin);
  void fin.then(() => fileDisposition.get(c.disposition) === fin && fileDisposition.delete(c.disposition));
  return suite;
}

async function ecrireDisposition(c: SpacePaths, widgets: readonly FreePlacement[]): Promise<void> {
  await mkdir(c.accueil, { recursive: true });
  const temporaire = `${c.disposition}.${randomUUID()}.tmp`;
  await writeFile(temporaire, JSON.stringify({ version: 3, widgets }, null, 2));
  await rename(temporaire, c.disposition);
}

/** The new layout, already validated: atomic write, in series (two close drags are not lost). */
export function placerWidgets(c: SpacePaths, placements: readonly FreePlacement[]): Promise<void> {
  return enSerie(c, () => ecrireDisposition(c, placements));
}

/**
 * The user removes a widget: its folder goes to accueil/.corbeille (nothing is destroyed), its place is freed and
 * `oublier` removes its grant and its data (a widget recreated under the same id must not inherit the grant).
 */
export async function retirerWidget(c: SpacePaths, id: string, oublier: (id: string) => Promise<void>): Promise<void> {
  if (!ID_WIDGET.test(id)) throw new Error(`id de widget invalide : ${id}`);
  await enSerie(c, async () => {
    const restants = (await readFreeLayout(c)).filter((p) => p.id !== id);
    const corbeille = join(c.accueil, ".corbeille");
    await mkdir(corbeille, { recursive: true });
    await rename(join(c.widgets, id), join(corbeille, `${id}-${Date.now()}`));
    await ecrireDisposition(c, restants);
  });
  await oublier(id);
}

/** The kept executions of a widget (`<dossierWidgets>/<id>`), outside the space; nothing for an invalid id. */
export async function executionsWidget(dossierWidgets: string, id: string): Promise<ResumeExecution[]> {
  if (!ID_WIDGET.test(id)) return [];
  return listerExecutions(join(dossierWidgets, id));
}

/** An execution of a widget; null if one of the two ids is invalid (never a path) or if it no longer exists. */
export async function executionWidget(dossierWidgets: string, id: string, execution: string): Promise<Execution | null> {
  if (!ID_WIDGET.test(id) || !ID_EXECUTION.test(execution)) return null;
  return lireExecution(join(dossierWidgets, id), execution);
}
