import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ID_EXECUTION,
  lireDispositionLibre,
  lireExecution,
  listerExecutions,
  placerManquantsLibre,
  PlacementLibre,
  taillesLibres,
  type CheminsEspace,
  type EtatAccueil,
  type Execution,
  type ResumeExecution,
  type ThemeAccueil,
} from "../../../packages/noyau/src/index.ts";
import type { WidgetAffiche } from "../shared/api.ts";

// Copied from Electron's main/agent/accueil.ts (which imports electron, so the Node host cannot import it): same rules,
// free placement (version 3) and the theme added.

const ID_WIDGET = /^[a-z0-9-]+$/;
/** L'URL du cadre : la copie assainie que la sidebar écrit, datée du mtime de la source (un nouveau mtime recharge). */
function urlAffichage(id: string, mtime: number): string {
  return `resource://webaios-widget-${id}/affichage-${mtime}.html`;
}
/** Taille donnée à un widget illisible (sans déclaration), pour qu'il garde une place et montre son erreur. */
const TAILLE_WIDGET_ILLISIBLE = { l: 4, h: 2 };

/**
 * Ce que l'interface affiche : chaque widget à sa place, avec ses données, son exemple et son état. `placements` : ce que
 * dit disposition.json ; les widgets absents sont posés au premier trou. `mtimes` : date de affichage.html par widget,
 * pour forcer le rechargement du cadre quand l'agent le réécrit.
 */
export function versWidgetsAffiches(o: {
  etat: EtatAccueil;
  placements: PlacementLibre[];
  theme: ThemeAccueil | null;
  mtimes: Record<string, number>;
}): { widgets: WidgetAffiche[]; theme: ThemeAccueil | null } {
  const defauts = new Map(o.etat.widgets.map((w) => [w.id, taillesLibres("declaration" in w ? w.declaration.tailles.defaut : TAILLE_WIDGET_ILLISIBLE)] as const));
  const placements = placerManquantsLibre(
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
 * Une disposition envoyée par l'interface : entiers, dans l'accueil, un widget connu, une seule fois, sans
 * chevauchement. Refusée en bloc sinon (l'interface relit alors l'ancienne disposition) : `lireDispositionLibre`
 * renvoie [] pour une disposition chevauchante, et l'écrire effacerait tout le placement au prochain lecture.
 */
export function validerPlacements(brut: unknown, ids: readonly string[]): PlacementLibre[] {
  if (!Array.isArray(brut)) throw new Error("placements invalides : liste attendue");
  const connus = new Set(ids);
  const placements = brut.map((p) => {
    const r = PlacementLibre.safeParse(p);
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

/** Écritures de disposition.json une par une, dans l'ordre des demandes : aucune ne lit l'état qu'une autre va changer. */
const fileDisposition = new Map<string, Promise<void>>();
function enSerie(c: CheminsEspace, ecrire: () => Promise<void>): Promise<void> {
  const suite = (fileDisposition.get(c.disposition) ?? Promise.resolve()).then(ecrire);
  const fin = suite.catch(() => {});
  fileDisposition.set(c.disposition, fin);
  void fin.then(() => fileDisposition.get(c.disposition) === fin && fileDisposition.delete(c.disposition));
  return suite;
}

async function ecrireDisposition(c: CheminsEspace, widgets: readonly PlacementLibre[]): Promise<void> {
  await mkdir(c.accueil, { recursive: true });
  const temporaire = `${c.disposition}.${randomUUID()}.tmp`;
  await writeFile(temporaire, JSON.stringify({ version: 3, widgets }, null, 2));
  await rename(temporaire, c.disposition);
}

/** La nouvelle disposition, déjà validée : écriture atomique, en série (deux glissers rapprochés ne se perdent pas). */
export function placerWidgets(c: CheminsEspace, placements: readonly PlacementLibre[]): Promise<void> {
  return enSerie(c, () => ecrireDisposition(c, placements));
}

/**
 * L'utilisateur retire un widget : son dossier part dans accueil/.corbeille (rien n'est détruit), sa place est libérée et
 * `oublier` retire son accord et ses données (un widget recréé sous le même id ne doit pas hériter de l'accord).
 */
export async function retirerWidget(c: CheminsEspace, id: string, oublier: (id: string) => Promise<void>): Promise<void> {
  if (!ID_WIDGET.test(id)) throw new Error(`id de widget invalide : ${id}`);
  await enSerie(c, async () => {
    const restants = (await lireDispositionLibre(c)).filter((p) => p.id !== id);
    const corbeille = join(c.accueil, ".corbeille");
    await mkdir(corbeille, { recursive: true });
    await rename(join(c.widgets, id), join(corbeille, `${id}-${Date.now()}`));
    await ecrireDisposition(c, restants);
  });
  await oublier(id);
}

/** Les exécutions gardées d'un widget (`<dossierWidgets>/<id>`), hors de l'espace ; rien pour un id invalide. */
export async function executionsWidget(dossierWidgets: string, id: string): Promise<ResumeExecution[]> {
  if (!ID_WIDGET.test(id)) return [];
  return listerExecutions(join(dossierWidgets, id));
}

/** Une exécution d'un widget ; null si l'un des deux ids est invalide (jamais un chemin) ou si elle n'existe plus. */
export async function executionWidget(dossierWidgets: string, id: string, execution: string): Promise<Execution | null> {
  if (!ID_WIDGET.test(id) || !ID_EXECUTION.test(execution)) return null;
  return lireExecution(join(dossierWidgets, id), execution);
}
