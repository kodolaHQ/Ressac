import type { DirectWidget, ActionsState, DirectState, Owner } from "@webaios/noyau";
import type { ApiWebaios } from "../../shared/api";
import type { Depot } from "./edition.svelte";
import type { Lanceur, SourceExecutions } from "./executions.svelte";

const PREFIXE_ACTION = "action:";

/**
 * A workflow's key in the window states (edits, unsaved codes, chosen run): a widget's id as is, `action:<id>` for
 * an action (a widget and an action with the same name do not get mixed up).
 */
export const cleCible = (c: Owner): string => (c.type === "widget" ? c.id : PREFIXE_ACTION + c.id);
export const cibleDeCle = (cle: string): Owner =>
  cle.startsWith(PREFIXE_ACTION) ? { type: "action", id: cle.slice(PREFIXE_ACTION.length) } : { type: "widget", id: cle };
export const estCleAction = (cle: string): boolean => cle.startsWith(PREFIXE_ACTION);

/** Reading and writing the workflow and its codes, addressed by key. */
export function depotDe(w: Pick<ApiWebaios["workflow"], "lire" | "enregistrer" | "lireCode" | "enregistrerCode">): Depot {
  return {
    lire: (cle) => w.lire(cibleDeCle(cle)),
    enregistrer: (cle, b) => w.enregistrer(cibleDeCle(cle), b),
    lireCode: (cle, nom) => w.lireCode(cibleDeCle(cle), nom),
    enregistrerCode: (cle, nom, texte) => w.enregistrerCode(cibleDeCle(cle), nom, texte),
  };
}

/** The runs of a widget (stored with home) or of an action. */
export function sourceExecutionsDe(api: Pick<ApiWebaios, "accueil" | "actions">, cible: Owner): SourceExecutions {
  if (cible.type === "widget") return api.accueil;
  return { executions: () => api.actions.executions(cible.id), execution: (_cle, e) => api.actions.execution(cible.id, e) };
}

/** What is running, seen as for widgets: a current action becomes a run (or a trial) of its key. */
export function directDesActions(e: ActionsState): DirectState {
  return {
    courants: e.courantes.map(
      (c): DirectWidget => ({
        widget: PREFIXE_ACTION + c.action,
        genre: c.essai ? "essai" : "execution",
        debut: c.debut,
        blocs: Object.fromEntries(Object.entries(c.blocs).map(([id, b]) => [id, { statut: b.statut, elements: b.elements }])),
      }),
    ),
    enAttente: e.enAttente.map((a) => PREFIXE_ACTION + a.action),
  };
}

/** « ▶ Lancer », « Rejouer » and live tracking: the widgets', or the actions'. */
export function lanceurDe(api: Pick<ApiWebaios, "workflow" | "actions">, cible: Owner): Lanceur {
  const w = api.workflow;
  const commun = {
    lancer: (cle: string, saisie?: string | null) => w.lancer(cibleDeCle(cle), saisie),
    rejouer: (cle: string, execution: string, bloc: string) => w.rejouer(cibleDeCle(cle), execution, bloc),
  };
  if (cible.type === "widget") return { ...commun, direct: () => w.direct(), surDirect: (r) => w.surDirect(r) };
  return { ...commun, direct: () => api.actions.direct().then(directDesActions), surDirect: (r) => api.actions.surDirect((e) => r(directDesActions(e))) };
}
