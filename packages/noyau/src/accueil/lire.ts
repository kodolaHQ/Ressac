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

/** Lit un JSON de l'espace en refusant un lien symbolique qui sortirait du dossier du widget. */
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
    // exemple.json absent ou abîmé : pas d'exemple.
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

/** Placements lisibles de disposition.json. L'ancien format (`{ ordre }`) ou un fichier abîmé donne []. */
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

/** Première place libre : rangées de haut en bas, puis colonnes de gauche à droite. */
function premierePlace(occupes: Rectangle[], l: number, h: number): { x: number; y: number } {
  for (let y = 0; ; y++) {
    for (let x = 0; x + l <= COLONNES; x++) {
      if (!occupes.some((o) => chevauche(o, { x, y, l, h }))) return { x, y };
    }
  }
}

/**
 * Place chaque widget présent sur le disque. Un placement valide est gardé ; un widget sans
 * placement, ou dont le placement chevauche un autre, est posé à la première place libre.
 */
export function placerManquants(ids: string[], voulus: Placement[], defauts: Map<string, { l: number; h: number }>): Placement[] {
  const retenus: Placement[] = [];
  const dejaVus = new Set<string>();
  for (const p of voulus) {
    if (!defauts.has(p.id) || dejaVus.has(p.id)) continue; // id inconnu ou doublon : ignoré
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

/** Première place libre en unités libres : x par pas de 8 ‰ (dernier x collé au bord), y par pas de 8 px. */
function premierePlaceLibre(occupes: Rectangle[], l: number, h: number): { x: number; y: number } {
  const xMax = LARGEUR_LIBRE - l;
  for (let y = 0; ; ) {
    for (let x = 0; ; x += PAS_X) {
      const xx = Math.min(x, xMax);
      if (!occupes.some((o) => chevauche(o, { x: xx, y, l, h }))) return { x: xx, y };
      if (xx === xMax) break;
    }
    // Un bas de widget peut tomber entre deux pas (90 px de haut, y = 90) : on l'essaie aussi.
    const bas = occupes.map((o) => o.y + o.h).filter((b) => b > y);
    y = bas.length > 0 ? Math.min(y + PAS_Y, ...bas) : y + PAS_Y;
  }
}

/** Placements de disposition.json en unités libres. Une autre version, un fichier abîmé ou un chevauchement donne []. */
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
 * Même contrat que placerManquants, en unités libres : un placement voulu valide est gardé, un id inconnu ou un
 * doublon est ignoré, et chaque widget absent est posé au premier trou sans chevauchement.
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

/** Lit la page d'accueil. Un widget cassé est signalé, il n'empêche pas de lire les autres. */
export async function lireAccueil(c: CheminsEspace, dossierWidgets: string): Promise<EtatAccueil> {
  if (!existsSync(c.widgets)) return { disposition: [], widgets: [] };
  const ids = (await readdir(c.widgets, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && ID_WIDGET.test(e.name))
    .map((e) => e.name)
    .sort();
  const widgets = await Promise.all(ids.map((id) => lireWidget(c, dossierWidgets, id)));
  // Un widget en erreur n'a pas de taille connue : il n'est pas placé.
  const defauts = new Map(widgets.flatMap((w) => ("declaration" in w ? [[w.id, w.declaration.tailles.defaut] as const] : [])));
  const disposition = placerManquants(ids, await lirePlacements(c), defauts);
  return { disposition, widgets };
}
