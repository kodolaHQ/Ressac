import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  ACTION_INCONNUE,
  avertirWorkflow,
  contexteValidation,
  contexteValidationAction,
  DeclarationWidget,
  enregistrerCode,
  enregistrerWorkflow,
  lireBrouillon,
  lireAction,
  lireCode,
  validerWorkflow,
  type DeclarationAction,
  type Avertissement,
  type CheminsEspace,
  type ActionsNoyau,
  type ResultatEnregistrement,
  type ResultatEssai,
  type WorkflowOuvert,
} from "@webaios/noyau";
import { cibleDeUrlWorkflow, type EtatNavigateur, type IdFenetre } from "../../commun/modele";
import type { Brouillon, EditionWorkflow, SelectionConstructeur } from "../../commun/api";
import { ACTION_TOURNE_DEJA, ACTIONS_EN_ESPACE_PRIVE } from "../../commun/actions";
import { espaceActifPrive } from "./actions";

export type { SelectionConstructeur };

/**
 * Ce que l'agent peut savoir du constructeur d'une fenêtre : seulement si l'onglet affiché est `webaios://workflow/<widget>`
 * ou `webaios://workflow/action/<action>` (page interne, donc invisible autrement) ; le bloc seulement si la sélection
 * vise ce workflow-là (un widget et une action du même nom sont deux workflows).
 */
export function workflowOuvertDe(
  etat: EtatNavigateur,
  selections: ReadonlyMap<IdFenetre, SelectionConstructeur>,
  fenetre: IdFenetre,
): WorkflowOuvert | null {
  const f = etat.fenetres.find((x) => x.id === fenetre);
  const id = f?.actif[f.espaceActif];
  const url = id ? etat.onglets[id]?.url : undefined;
  const cible = url ? cibleDeUrlWorkflow(url) : null;
  if (!cible) return null;
  const s = selections.get(fenetre);
  if (cible.type === "widget") return { widget: cible.id, bloc: s && "widget" in s && s.widget === cible.id ? s.bloc : null };
  return { action: cible.id, bloc: s && "action" in s && s.action === cible.id ? s.bloc : null };
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
  return dossierConfine(chemins.widgets, id);
}

/** Le dossier d'une action, avec les mêmes gardes que celui d'un widget (dans `~/WebAiOs/actions`, jamais un lien). */
export async function dossierActionSur(chemins: CheminsEspace, id: string): Promise<string | null> {
  return dossierConfine(chemins.actions, id);
}

async function dossierConfine(parent: string, id: string): Promise<string | null> {
  try {
    if ((await lstat(parent)).isSymbolicLink()) return null;
    const dossier = join(parent, id);
    const l = await lstat(dossier);
    if (l.isSymbolicLink() || !l.isDirectory()) return null;
    const [racine, reel] = await Promise.all([realpath(parent), realpath(dossier)]);
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

function avertissementsDe(brut: unknown, d: DeclarationWidget): Avertissement[] {
  const r = validerWorkflow(brut, contexteValidation(d));
  return r.ok ? avertirWorkflow(r.valide.workflow, { sources: d.sources, config: d.config, dureeMaxMinutes: d.recolte?.dureeMaxMinutes ?? null }, r.valide) : [];
}

/** Ce que le constructeur ouvre pour un widget ; null : widget inconnu (ou widget.json illisible), sans récolte, ou disque en erreur. N'écrit rien. */
export async function lireEdition(c: Contexte, id: string): Promise<EditionWorkflow | null> {
  try {
    const d = await lireDeclaration(c.chemins, id);
    if (!("declaration" in d)) return null;
    const l = await lireBrouillon(d.dossier, contexteValidation(d.declaration));
    if (!l) return null;
    const decl = d.declaration;
    const r = decl.recolte;
    return {
      ...l,
      avertissements: l.brut === null ? [] : avertissementsDe(l.brut, decl),
      widget: {
        nom: decl.nom,
        compte: decl.sources.compte,
        publiques: decl.sources.publiques,
        config: decl.config ?? null,
        web: decl.sources.web,
        recolte: r
          ? { minutes: r.minutes ?? null, heures: r.heures ?? [], dureeMaxMinutes: r.dureeMaxMinutes ?? null, notifier: r.notifier === true }
          : null,
      },
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
    const r = await enregistrerWorkflow({
      dossierFichiers: d.dossier,
      dossierDonnees: join(c.dossierWidgets, id),
      brut,
      contexte: contexteValidation(d.declaration),
    });
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

// --- Le workflow d'une action (`webaios://workflow/action/<id>`) ---

type ContexteAction = { chemins: CheminsEspace; dossierActions: string };

/** `action.json` lu, et le dossier de l'action (confiné) ; null : action inconnue ; `erreur` : déclaration illisible. */
async function declarationAction(chemins: CheminsEspace, id: string): Promise<{ declaration: DeclarationAction; dossier: string } | { erreur: string } | null> {
  const dossier = await dossierActionSur(chemins, id);
  const a = dossier ? await lireAction(chemins, id) : null;
  if (!dossier || !a) return null;
  return "erreur" in a ? { erreur: a.erreur } : { declaration: a.declaration, dossier };
}

function avertissementsAction(brut: unknown, d: DeclarationAction): Avertissement[] {
  const r = validerWorkflow(brut, contexteValidationAction(d));
  if (!r.ok) return [];
  return avertirWorkflow(
    r.valide.workflow,
    { sources: d.sources, config: null, dureeMaxMinutes: d.dureeMaxMinutes ?? null, proprietaire: "action", saisie: d.saisie !== undefined },
    r.valide,
  );
}

/**
 * Ce que le constructeur ouvre pour une action : son `workflow.json` seulement (aucun workflow implicite), validé selon
 * `action.json` (sortie vers la page, `{saisie}`…). null : action inconnue, `action.json` illisible, sans workflow, ou
 * disque en erreur. N'écrit rien.
 */
export async function lireEditionAction(c: ContexteAction, id: string): Promise<EditionWorkflow | null> {
  try {
    const d = await declarationAction(c.chemins, id);
    if (!d || "erreur" in d) return null;
    const decl = d.declaration;
    const l = await lireBrouillon(d.dossier, contexteValidationAction(decl));
    if (!l || l.origine !== "fichier") return null;
    return {
      ...l,
      avertissements: l.brut === null ? [] : avertissementsAction(l.brut, decl),
      action: {
        nom: decl.nom,
        compte: decl.sources.compte,
        publiques: decl.sources.publiques,
        web: decl.sources.web,
        saisie: decl.saisie ?? null,
        miseEnPage: decl.miseEnPage ?? null,
        dureeMaxMinutes: decl.dureeMaxMinutes ?? null,
      },
    };
  } catch (e) {
    console.error(`[webaios] lecture du workflow de l'action ${id} :`, e);
    return null;
  }
}

/** Enregistre le brouillon de l'action (mémoire de ses blocs changés effacée hors de l'espace) ; `action.json` n'est jamais écrit. */
export async function enregistrerEditionAction(c: ContexteAction, id: string, brut: unknown): Promise<ResultatEnregistrement & { avertissements: Avertissement[] }> {
  try {
    const d = await declarationAction(c.chemins, id);
    if (!d) return { ok: false, erreur: ACTION_INCONNUE, avertissements: [] };
    if ("erreur" in d) return { ok: false, erreur: d.erreur, avertissements: [] };
    const r = await enregistrerWorkflow({
      dossierFichiers: d.dossier,
      dossierDonnees: join(c.dossierActions, id),
      brut,
      contexte: contexteValidationAction(d.declaration),
    });
    return { ...r, avertissements: r.ok ? avertissementsAction(brut, d.declaration) : [] };
  } catch (e) {
    console.error(`[webaios] enregistrement du workflow de l'action ${id} :`, e);
    return { ok: false, erreur: MESSAGE_ILLISIBLE, avertissements: [] };
  }
}

export async function lireCodeAction(chemins: CheminsEspace, id: string, nom: string): Promise<{ texte: string } | { absent: true } | { erreur: string }> {
  const dossier = await dossierActionSur(chemins, id);
  if (!dossier) return { erreur: ACTION_INCONNUE };
  return lireCode(dossier, nom);
}

/** À appeler dans `enSerie` : le dossier est revérifié juste avant d'écrire. */
export async function enregistrerCodeAction(chemins: CheminsEspace, id: string, nom: string, texte: string): Promise<{ ok: true } | { ok: false; erreur: string }> {
  const dossier = await dossierActionSur(chemins, id);
  if (!dossier) return { ok: false, erreur: ACTION_INCONNUE };
  try {
    return await enregistrerCode(dossier, nom, texte);
  } catch (e) {
    console.error(`[webaios] code de l'action ${id} :`, e);
    return { ok: false, erreur: MESSAGE_ILLISIBLE };
  }
}

type Code = { texte: string } | { absent: true } | { erreur: string };
type Ecrit = { ok: true } | { ok: false; erreur: string };

/**
 * Le constructeur d'une action, côté main : chaque appel nomme sa fenêtre et est refusé quand son espace actif est privé
 * (une fenêtre inconnue compte comme privée). Lancer ou rejouer une action qui tourne déjà ne prend jamais cette
 * exécution-là pour la sienne : `ACTION_TOURNE_DEJA`.
 */
export function creerConstructeurActions(o: {
  etat: () => Pick<EtatNavigateur, "espaces" | "fenetres">;
  noyau: () => { actions: Pick<ActionsNoyau, "lancer" | "rejouer"> } | null;
  chemins: () => CheminsEspace | null;
  dossierActions: string;
  file: FileEcritures;
  /** Sans agent. */
  messageArrete: string;
}) {
  const prive = (f: IdFenetre) => espaceActifPrive(o.etat(), f);
  const cle = (id: string) => `action:${id}`;
  return {
    async lire(f: IdFenetre, id: string): Promise<EditionWorkflow | null> {
      const chemins = o.chemins();
      return !chemins || prive(f) ? null : lireEditionAction({ chemins, dossierActions: o.dossierActions }, id);
    },
    async enregistrer(f: IdFenetre, id: string, brouillon: Brouillon): Promise<ResultatEnregistrement & { avertissements: Avertissement[] }> {
      const chemins = o.chemins();
      if (!chemins) return { ok: false, erreur: o.messageArrete, avertissements: [] };
      if (prive(f)) return { ok: false, erreur: ACTIONS_EN_ESPACE_PRIVE, avertissements: [] };
      return o.file.enSerie(cle(id), () => enregistrerEditionAction({ chemins, dossierActions: o.dossierActions }, id, brouillon));
    },
    async lireCode(f: IdFenetre, id: string, nom: string): Promise<Code> {
      const chemins = o.chemins();
      if (!chemins) return { erreur: o.messageArrete };
      return prive(f) ? { erreur: ACTIONS_EN_ESPACE_PRIVE } : lireCodeAction(chemins, id, nom);
    },
    async enregistrerCode(f: IdFenetre, id: string, nom: string, texte: string): Promise<Ecrit> {
      const chemins = o.chemins();
      if (!chemins) return { ok: false, erreur: o.messageArrete };
      if (prive(f)) return { ok: false, erreur: ACTIONS_EN_ESPACE_PRIVE };
      return o.file.enSerie(cle(id), () => enregistrerCodeAction(chemins, id, nom, texte));
    },
    /** Un essai : son résultat se voit dans l'aperçu du constructeur, jamais comme dernier résultat. */
    async rejouer(f: IdFenetre, id: string, execution: string, bloc: string): Promise<ResultatEssai> {
      const noyau = o.noyau();
      if (!noyau) return { ok: false, erreur: o.messageArrete };
      if (prive(f)) return { ok: false, erreur: ACTIONS_EN_ESPACE_PRIVE };
      const l = noyau.actions.rejouer(id, execution, bloc);
      if (l.deja) return { ok: false, erreur: ACTION_TOURNE_DEJA };
      const r = await l.fin;
      return r.statut !== "invalide" && r.execution !== undefined ? { ok: true, execution: r.execution, statut: r.statut } : { ok: false, erreur: r.erreur ?? "Rejeu impossible" };
    },
    /** Sans noyau : {} (rien n'est choisi). Une saisie différente pendant que l'action tourne n'est pas perdue sans le dire. */
    async lancer(f: IdFenetre, id: string, saisie: string | null): Promise<{ execution?: string; erreur?: string }> {
      const noyau = o.noyau();
      if (!noyau) return {};
      if (prive(f)) return { erreur: ACTIONS_EN_ESPACE_PRIVE };
      const l = noyau.actions.lancer(id, { ...(saisie?.trim() ? { saisie } : {}), declencheur: "manuelle" });
      if (l.deja) return { erreur: ACTION_TOURNE_DEJA };
      const r = await l.fin;
      if (r.execution !== undefined) return { execution: r.execution };
      return r.erreur !== undefined ? { erreur: r.erreur } : {};
    },
  };
}
