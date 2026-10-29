import { protocol } from "electron";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { lireExecution, listerExecutions, placerManquants, type CheminsEspace, type EtatAccueil, type Execution, type ResumeExecution } from "@webaios/noyau";
import { SchemaIdExecution, SchemaIdWidget, SchemaPlacements, type Placement, type ProfilPourAccord, type WidgetAffiche } from "../../commun/api";
import type { EtatNavigateur, IdFenetre } from "../../commun/modele";
import { contientIndiceReseau } from "../../commun/indices-reseau";
import { profilsLisibles, urlPermise } from "./lecture-invisible";

export const SCHEMA_WIDGET = "webaios-widget";
const ID_WIDGET = /^[a-z0-9-]+$/;
/**
 * L'affichage d'un widget exécute son script en ligne, mais ne charge rien et n'envoie rien : ni réseau, ni
 * formulaire, ni cadre. Ses liens passent par `postMessage` vers l'interface (d'où aucune `<base>`).
 */
export const CSP_WIDGET =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types default";
/**
 * Servi à la place d'un affichage qui contient un indice réseau (voir indices-reseau.ts) : le parseur le traiterait avant
 * tout script, donc avant la garde du preload.
 */
export const AFFICHAGE_REFUSE =
  '<!doctype html><meta charset="utf-8"><p style="font: 13px system-ui; color: #b44">Affichage refusé : il contient &lt;link&gt;, &lt;meta http-equiv&gt; ou des règles de spéculation, qui feraient sortir des données. Voir AGENTS.md.</p>';
/** Taille donnée à un widget illisible (sans déclaration), pour qu'il garde une place et montre son erreur. */
const TAILLE_WIDGET_ILLISIBLE = { l: 4, h: 2 };

/**
 * Ce que l'interface affiche : chaque widget à sa place, avec ses données, son exemple et son état. `mtimes` : date de
 * affichage.html par widget, pour forcer le rechargement de l'iframe quand l'agent le réécrit.
 */
export function versWidgetsAffiches(etat: EtatAccueil, mtimes: Record<string, number>): WidgetAffiche[] {
  const defauts = new Map(etat.widgets.map((w) => [w.id, "declaration" in w ? w.declaration.tailles.defaut : TAILLE_WIDGET_ILLISIBLE] as const));
  const placements = placerManquants(
    etat.widgets.map((w) => w.id),
    etat.disposition,
    defauts,
  );
  return placements.flatMap((placement): WidgetAffiche[] => {
    const w = etat.widgets.find((x) => x.id === placement.id);
    if (!w) return [];
    if ("erreur" in w) return [{ id: w.id, erreur: w.erreur, placement }];
    return [
      {
        id: w.id,
        nom: w.declaration.nom,
        placement,
        tailles: w.declaration.tailles,
        src: w.aAffichage ? `${SCHEMA_WIDGET}://${w.id}/affichage.html?v=${mtimes[w.id] ?? 0}` : null,
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
}

/** Les widgets lus par le noyau, prêts à afficher. */
export async function lireWidgetsAffiches(etat: EtatAccueil): Promise<WidgetAffiche[]> {
  const mtimes: Record<string, number> = {};
  for (const w of etat.widgets) {
    if (!("aAffichage" in w) || !w.aAffichage) continue;
    try {
      mtimes[w.id] = Math.round((await stat(join(w.dossier, "affichage.html"))).mtimeMs);
    } catch {
      // affichage.html supprimé entre-temps : la prochaine lecture le dira
    }
  }
  return versWidgetsAffiches(etat, mtimes);
}

/** Les exécutions gardées d'un widget (`<dossierWidgets>/<id>`), hors de l'espace ; rien pour un id invalide. */
export async function executionsWidget(dossierWidgets: string, id: string): Promise<ResumeExecution[]> {
  if (!SchemaIdWidget.safeParse(id).success) return [];
  return listerExecutions(join(dossierWidgets, id));
}

/** Une exécution d'un widget ; null si l'un des deux ids est invalide (jamais un chemin) ou si elle n'existe plus. */
export async function executionWidget(dossierWidgets: string, id: string, execution: string): Promise<Execution | null> {
  if (!SchemaIdWidget.safeParse(id).success || !SchemaIdExecution.safeParse(execution).success) return null;
  return lireExecution(join(dossierWidgets, id), execution);
}

/** Fichier servi pour une URL `webaios-widget:` : seulement `<widgets>/<id>/affichage.html`, sinon null. */
export function cheminAffichage(widgets: string, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEMA_WIDGET}:` || !ID_WIDGET.test(u.hostname) || u.pathname !== "/affichage.html") return null;
  return join(widgets, u.hostname, "affichage.html");
}

/** L'id du widget dont `url` est l'affichage (`webaios-widget://<id>/affichage.html`, paramètres permis), sinon null. */
export function widgetDuCadre(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === `${SCHEMA_WIDGET}:` && ID_WIDGET.test(u.hostname) && u.pathname === "/affichage.html" ? u.hostname : null;
}

/**
 * Un cadre de l'interface peut aller vers `cible` : seulement l'affichage d'un widget et, s'il en montre déjà un, celui
 * du même widget (rechargement quand l'agent le réécrit). Un cadre neuf (`""`, `about:blank`) ou resté sur la page
 * d'erreur de Chromium (après une navigation bloquée, sans script) charge un affichage : seule l'interface, qui garde
 * un cadre par widget, change sa source.
 */
export function navigationCadrePermise(actuelle: string, cible: string): boolean {
  const vers = widgetDuCadre(cible);
  if (!vers) return false;
  if (actuelle === "" || actuelle === "about:blank" || actuelle.startsWith("chrome-error:")) return true;
  return widgetDuCadre(actuelle) === vers;
}

/**
 * Le HTML de l'affichage, ou null s'il n'existe pas, ou si un lien symbolique le fait sortir de son widget : le dossier
 * des widgets ne doit pas être un lien, le dossier du widget doit rester dedans, et le fichier dans le dossier du widget
 * (l'agent écrit dans ces dossiers : il ne doit pas y montrer un fichier du Mac).
 */
export async function lireAffichage(widgets: string, url: string): Promise<string | null> {
  const chemin = cheminAffichage(widgets, url);
  if (!chemin) return null;
  try {
    if ((await lstat(widgets)).isSymbolicLink()) return null;
    const racine = await realpath(widgets);
    const [dossier, reel] = await Promise.all([realpath(join(chemin, "..")), realpath(chemin)]);
    if (!dossier.startsWith(racine + sep) || !reel.startsWith(dossier + sep)) return null;
    return await readFile(reel, "utf8");
  } catch {
    return null;
  }
}

/** Réponse du schéma `webaios-widget:` ; `widgets` : dossier des widgets, null tant que le noyau n'est pas prêt. */
export async function repondreWidget(widgets: string | null, url: string): Promise<Response> {
  const html = widgets ? await lireAffichage(widgets, url) : null;
  if (html === null) return new Response("", { status: 404 });
  return new Response(contientIndiceReseau(html) ? AFFICHAGE_REFUSE : html, {
    // X-DNS-Prefetch-Control : la résolution des liens reste coupée, même si le document essaie de la rallumer.
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP_WIDGET, "X-DNS-Prefetch-Control": "off" },
  });
}

/**
 * Avant `app.whenReady` : le schéma doit être standard pour que les URL aient un hôte (l'id du widget). Un seul appel
 * enregistre tous les schémas (un second remplacerait le premier) : `autres` y ajoute ceux du reste de l'app.
 */
export function enregistrerSchemaWidget(autres: string[] = []): void {
  protocol.registerSchemesAsPrivileged([SCHEMA_WIDGET, ...autres].map((scheme) => ({ scheme, privileges: { standard: true, secure: true } })));
}

/** Sert les affichages des widgets à l'interface. */
export function servirWidgets(widgets: () => string | null): void {
  protocol.handle(SCHEMA_WIDGET, (requete) => repondreWidget(widgets(), requete.url));
}

/**
 * Seul un lien http(s) d'un widget s'ouvre (dans un onglet) : ni `javascript:`, ni `file:`, ni une adresse de la machine
 * ou du réseau local (l'agent écoute sur des ports locaux : un lien y porterait les données du widget).
 */
export function urlOuvrable(url: string): boolean {
  return urlPermise(url, undefined);
}

/**
 * Permissions demandées dans la session de l'interface : seule sa propre page (le cadre principal) en a ; un affichage
 * de widget, ou tout autre cadre, n'a rien (ni caméra, ni notifications, ni presse-papiers…).
 */
export function permissionInterface(d: { requestingUrl?: string; isMainFrame?: boolean }): boolean {
  return d.isMainFrame === true && !(d.requestingUrl ?? "").startsWith(`${SCHEMA_WIDGET}:`);
}

/**
 * Les profils qu'un accord peut utiliser : jamais celui d'un espace privé (même partagé avec un espace non privé).
 * Coché par défaut : celui de l'espace actif de la fenêtre, s'il est lisible.
 */
export function profilsPourAccord(etat: Pick<EtatNavigateur, "profils" | "espaces" | "fenetres">, fenetreId: IdFenetre | undefined): ProfilPourAccord[] {
  const fenetre = etat.fenetres.find((f) => f.id === fenetreId);
  const actif = fenetre ? etat.espaces.find((e) => e.id === fenetre.espaceActif)?.profil : undefined;
  return profilsLisibles(etat).map((id) => {
    const espaces = etat.espaces.filter((e) => e.profil === id).map((e) => e.nom);
    return { id, libelle: espaces.length ? `Profil de « ${espaces.join(", ")} »` : `Profil « ${id} »`, parDefaut: id === actif };
  });
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

async function ecrireDisposition(c: CheminsEspace, widgets: Placement[]): Promise<void> {
  await mkdir(c.accueil, { recursive: true });
  const temporaire = `${c.disposition}.${randomUUID()}.tmp`;
  await writeFile(temporaire, JSON.stringify({ version: 2, widgets }, null, 2));
  await rename(temporaire, c.disposition);
}

/** Les placements lisibles de disposition.json (version 2), sinon []. */
async function placementsLus(c: CheminsEspace): Promise<Placement[]> {
  try {
    const lu = JSON.parse(await readFile(c.disposition, "utf8")) as { version?: unknown; widgets?: unknown };
    if (lu.version !== 2 || !Array.isArray(lu.widgets)) return [];
    return lu.widgets.flatMap((w) => {
      const r = SchemaPlacements.element.safeParse(w);
      return r.success ? [r.data] : [];
    });
  } catch {
    return [];
  }
}

/**
 * L'utilisateur a déplacé ou redimensionné un widget : la nouvelle disposition (écriture atomique, en série). Refusée en bloc
 * si un placement n'est pas entier, sort de la grille, vise un widget inconnu ou un widget deux fois.
 */
export function placerWidgets(c: CheminsEspace, placements: Placement[]): Promise<void> {
  const r = SchemaPlacements.safeParse(placements);
  if (!r.success) return Promise.reject(new Error(`placements invalides : ${r.error.message}`));
  const inconnus = r.data.filter((p) => !existsSync(join(c.widgets, p.id)));
  if (inconnus.length) return Promise.reject(new Error(`widget inconnu : ${inconnus.map((p) => p.id).join(", ")}`));
  return enSerie(c, () => ecrireDisposition(c, r.data));
}

/**
 * L'utilisateur retire un widget : son dossier part dans accueil/.corbeille (rien n'est détruit), sa place est libérée et
 * `oublier` retire son accord et ses données (un widget recréé sous le même id ne doit pas hériter de l'accord).
 */
export async function retirerWidget(c: CheminsEspace, id: string, oublier: (id: string) => Promise<void>): Promise<void> {
  if (!ID_WIDGET.test(id)) throw new Error(`id de widget invalide : ${id}`);
  await enSerie(c, async () => {
    const restants = (await placementsLus(c)).filter((p) => p.id !== id);
    const corbeille = join(c.accueil, ".corbeille");
    await mkdir(corbeille, { recursive: true });
    await rename(join(c.widgets, id), join(corbeille, `${id}-${Date.now()}`));
    await ecrireDisposition(c, restants);
  });
  await oublier(id);
}
