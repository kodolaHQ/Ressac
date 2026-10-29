import { join } from "node:path";
import {
  avertirWorkflow,
  enregistrerWorkflow,
  lireAccueil,
  lireBrouillon,
  validerWorkflow,
  type Avertissement,
  type CheminsEspace,
  type ResultatEnregistrement,
  type WorkflowOuvert,
} from "@webaios/noyau";
import { PREFIXE_WORKFLOW, type EtatNavigateur, type IdFenetre } from "../../commun/modele";
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
  if (!url?.startsWith(PREFIXE_WORKFLOW)) return null;
  const widget = url.slice(PREFIXE_WORKFLOW.length);
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

async function declarationDe(c: Contexte, id: string) {
  const w = (await lireAccueil(c.chemins, c.dossierWidgets)).widgets.find((x) => x.id === id);
  return w && "declaration" in w ? w.declaration : null;
}

function avertissementsDe(brut: unknown, d: { sources: { compte: readonly string[]; publiques: readonly string[] }; config?: unknown }): Avertissement[] {
  const r = validerWorkflow(brut);
  return r.ok ? avertirWorkflow(r.valide.workflow, { sources: d.sources, config: d.config }) : [];
}

/** Ce que le constructeur ouvre pour un widget ; null : widget inconnu (ou widget.json illisible) ou sans récolte. N'écrit rien. */
export async function lireEdition(c: Contexte, id: string): Promise<EditionWorkflow | null> {
  const d = await declarationDe(c, id);
  if (!d) return null;
  const l = await lireBrouillon(join(c.chemins.widgets, id));
  if (!l) return null;
  return {
    ...l,
    avertissements: l.brut === null ? [] : avertissementsDe(l.brut, d),
    widget: { nom: d.nom, compte: d.sources.compte, publiques: d.sources.publiques, config: d.config ?? null },
  };
}

/** Enregistre le brouillon du widget ; les avertissements sont ceux du workflow validé (aucun s'il est invalide). */
export async function enregistrerEdition(c: Contexte, id: string, brut: unknown): Promise<ResultatEnregistrement & { avertissements: Avertissement[] }> {
  const d = await declarationDe(c, id);
  if (!d) return { ok: false, erreur: "Widget introuvable", avertissements: [] };
  const r = await enregistrerWorkflow({ dossierFichiers: join(c.chemins.widgets, id), dossierDonnees: join(c.dossierWidgets, id), brut });
  return { ...r, avertissements: r.ok ? avertissementsDe(brut, d) : [] };
}
