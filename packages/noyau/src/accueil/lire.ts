import { readdir, readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import type { CheminsEspace } from "../chemins.js";
import { lireDonnees, lireEtatWidget } from "./donnees.js";
import { COLONNES, DeclarationWidget, Placement, type EtatAccueil, type WidgetLu } from "./schemas.js";

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
  return {
    id,
    dossier,
    declaration,
    etat,
    donnees,
    exemple,
    aRecolte: existsSync(join(dossier, "recolte.mjs")),
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
