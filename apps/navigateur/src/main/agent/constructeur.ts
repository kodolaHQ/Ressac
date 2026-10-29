import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  avertirWorkflow,
  DeclarationWidget,
  enregistrerCode,
  enregistrerWorkflow,
  lireBrouillon,
  lireCode,
  validerWorkflow,
  type Avertissement,
  type CheminsEspace,
  type ResultatEnregistrement,
  type WorkflowOuvert,
} from "@webaios/noyau";
import { widgetDeUrlWorkflow, type EtatNavigateur, type IdFenetre } from "../../commun/modele";
import type { EditionWorkflow } from "../../commun/api";

/** Le bloc sélectionné dans le constructeur d'une fenêtre. */
export type SelectionConstructeur = { widget: string; bloc: string | null };

/**
 * Ce que l'agent peut savoir du constructeur d'une fenêtre : seulement si l'onglet affiché est `webaios://workflow/<widget>`
 * (page interne, donc invisible autrement) ; le bloc seulement si la sélection vise ce widget.
 */
export function workflowOuvertDe(
  etat: EtatNavigateur,
  selections: ReadonlyMap<IdFenetre, SelectionConstructeur>,
  fenetre: IdFenetre,
): WorkflowOuvert | null {
  const f = etat.fenetres.find((x) => x.id === fenetre);
  const id = f?.actif[f.espaceActif];
  const url = id ? etat.onglets[id]?.url : undefined;
  const widget = url ? widgetDeUrlWorkflow(url) : null;
  if (!widget) return null;
  const s = selections.get(fenetre);
  return { widget, bloc: s && s.widget === widget ? s.bloc : null };
}

/** Écritures d'un même widget l'une après l'autre (enregistrements et codes), widgets différents en parallèle. */
export class FileEcritures {
  private queues = new Map<string, Promise<unknown>>();

  enSerie<T>(widget: string, f: () => Promise<T>): Promise<T> {
    const precedent = this.queues.get(widget) ?? Promise.resolve();
    const courant = precedent.then(f, f);
    const fin = courant.catch(() => undefined);
    this.queues.set(widget, fin);
    void fin.then(() => {
      if (this.queues.get(widget) === fin) this.queues.delete(widget);
    });
    return courant;
  }
}

type Contexte = { chemins: CheminsEspace; dossierWidgets: string };

const MESSAGE_ILLISIBLE = "Écriture impossible";

/**
 * Le dossier du widget, ou null : le dossier des widgets ne doit pas être un lien, le dossier du widget doit être un vrai
 * dossier (pas un lien) et rester dans celui des widgets. L'agent écrit là : il ne doit pas y rediriger une lecture ou
 * une écriture vers un fichier du Mac.
 */
export async function dossierWidgetSur(chemins: CheminsEspace, id: string): Promise<string | null> {
  try {
    if ((await lstat(chemins.widgets)).isSymbolicLink()) return null;
    const dossier = join(chemins.widgets, id);
    const l = await lstat(dossier);
    if (l.isSymbolicLink() || !l.isDirectory()) return null;
    const [racine, reel] = await Promise.all([realpath(chemins.widgets), realpath(dossier)]);
    return reel.startsWith(racine + sep) ? dossier : null;
  } catch {
    return null;
  }
}

export type Declaration = { declaration: DeclarationWidget; dossier: string } | { absent: true } | { invalide: string };

/** `widget.json` d'un widget seulement (pas toute la page d'accueil), sans suivre un lien qui sortirait du dossier. */
export async function lireDeclaration(chemins: CheminsEspace, id: string): Promise<Declaration> {
  const dossier = await dossierWidgetSur(chemins, id);
  if (!dossier) return { absent: true };
  try {
    const [racine, reel] = await Promise.all([realpath(dossier), realpath(join(dossier, "widget.json"))]);
    if (!reel.startsWith(racine + sep)) return { invalide: "widget.json sort du dossier du widget" };
    return { declaration: DeclarationWidget.parse(JSON.parse(await readFile(reel, "utf8"))), dossier };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { absent: true };
    return { invalide: (e as Error).message };
  }
}

function avertissementsDe(brut: unknown, d: { sources: { compte: readonly string[]; publiques: readonly string[] }; config?: unknown }): Avertissement[] {
  const r = validerWorkflow(brut);
  return r.ok ? avertirWorkflow(r.valide.workflow, { sources: d.sources, config: d.config }) : [];
}

/** Ce que le constructeur ouvre pour un widget ; null : widget inconnu (ou widget.json illisible), sans récolte, ou disque en erreur. N'écrit rien. */
export async function lireEdition(c: Contexte, id: string): Promise<EditionWorkflow | null> {
  try {
    const d = await lireDeclaration(c.chemins, id);
    if (!("declaration" in d)) return null;
    const l = await lireBrouillon(d.dossier);
    if (!l) return null;
    const decl = d.declaration;
    return {
      ...l,
      avertissements: l.brut === null ? [] : avertissementsDe(l.brut, decl),
      widget: { nom: decl.nom, compte: decl.sources.compte, publiques: decl.sources.publiques, config: decl.config ?? null },
    };
  } catch (e) {
    console.error(`[webaios] lecture du workflow du widget ${id} :`, e);
    return null;
  }
}

/** Enregistre le brouillon du widget ; les avertissements sont ceux du workflow validé (aucun s'il est invalide). */
export async function enregistrerEdition(c: Contexte, id: string, brut: unknown): Promise<ResultatEnregistrement & { avertissements: Avertissement[] }> {
  try {
    const d = await lireDeclaration(c.chemins, id);
    if ("invalide" in d) return { ok: false, erreur: `widget.json invalide : ${d.invalide}`, avertissements: [] };
    if (!("declaration" in d)) return { ok: false, erreur: "Widget introuvable", avertissements: [] };
    const r = await enregistrerWorkflow({ dossierFichiers: d.dossier, dossierDonnees: join(c.dossierWidgets, id), brut });
    return { ...r, avertissements: r.ok ? avertissementsDe(brut, d.declaration) : [] };
  } catch (e) {
    console.error(`[webaios] enregistrement du workflow du widget ${id} :`, e);
    return { ok: false, erreur: MESSAGE_ILLISIBLE, avertissements: [] };
  }
}

export async function lireCodeSur(chemins: CheminsEspace, id: string, nom: string): Promise<{ texte: string } | { absent: true } | { erreur: string }> {
  const dossier = await dossierWidgetSur(chemins, id);
  if (!dossier) return { erreur: "Widget introuvable" };
  return lireCode(dossier, nom);
}

/** À appeler dans `enSerie` : le dossier est revérifié juste avant d'écrire. */
export async function enregistrerCodeSur(chemins: CheminsEspace, id: string, nom: string, texte: string): Promise<{ ok: true } | { ok: false; erreur: string }> {
  const dossier = await dossierWidgetSur(chemins, id);
  if (!dossier) return { ok: false, erreur: "Widget introuvable" };
  try {
    return await enregistrerCode(dossier, nom, texte);
  } catch (e) {
    console.error(`[webaios] code du widget ${id} :`, e);
    return { ok: false, erreur: MESSAGE_ILLISIBLE };
  }
}
