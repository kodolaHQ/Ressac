import type { DirectWidget, EtatActions, EtatDirect, Proprietaire } from "@webaios/noyau";
import type { ApiWebaios } from "../../commun/api";
import type { Depot } from "./edition.svelte";
import type { Lanceur, SourceExecutions } from "./executions.svelte";

const PREFIXE_ACTION = "action:";

/**
 * La clé d'un workflow dans les états de la fenêtre (éditions, codes non enregistrés, exécution choisie) : l'id d'un
 * widget tel quel, `action:<id>` pour une action (un widget et une action du même nom ne se mélangent pas).
 */
export const cleCible = (c: Proprietaire): string => (c.type === "widget" ? c.id : PREFIXE_ACTION + c.id);
export const cibleDeCle = (cle: string): Proprietaire =>
  cle.startsWith(PREFIXE_ACTION) ? { type: "action", id: cle.slice(PREFIXE_ACTION.length) } : { type: "widget", id: cle };
export const estCleAction = (cle: string): boolean => cle.startsWith(PREFIXE_ACTION);

/** Lecture et écriture du workflow et de ses codes, adressées par clé. */
export function depotDe(w: Pick<ApiWebaios["workflow"], "lire" | "enregistrer" | "lireCode" | "enregistrerCode">): Depot {
  return {
    lire: (cle) => w.lire(cibleDeCle(cle)),
    enregistrer: (cle, b) => w.enregistrer(cibleDeCle(cle), b),
    lireCode: (cle, nom) => w.lireCode(cibleDeCle(cle), nom),
    enregistrerCode: (cle, nom, texte) => w.enregistrerCode(cibleDeCle(cle), nom, texte),
  };
}

/** Les exécutions d'un widget (rangées avec l'accueil) ou d'une action. */
export function sourceExecutionsDe(api: Pick<ApiWebaios, "accueil" | "actions">, cible: Proprietaire): SourceExecutions {
  if (cible.type === "widget") return api.accueil;
  return { executions: () => api.actions.executions(cible.id), execution: (_cle, e) => api.actions.execution(cible.id, e) };
}

/** Ce qui tourne, vu comme pour les widgets : une action courante devient une exécution (ou un essai) de sa clé. */
export function directDesActions(e: EtatActions): EtatDirect {
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

/** « ▶ Lancer », « Rejouer » et le suivi en direct : ceux des widgets, ou ceux des actions. */
export function lanceurDe(api: Pick<ApiWebaios, "workflow" | "actions">, cible: Proprietaire): Lanceur {
  const w = api.workflow;
  const commun = {
    lancer: (cle: string, saisie?: string | null) => w.lancer(cibleDeCle(cle), saisie),
    rejouer: (cle: string, execution: string, bloc: string) => w.rejouer(cibleDeCle(cle), execution, bloc),
  };
  if (cible.type === "widget") return { ...commun, direct: () => w.direct(), surDirect: (r) => w.surDirect(r) };
  return { ...commun, direct: () => api.actions.direct().then(directDesActions), surDirect: (r) => api.actions.surDirect((e) => r(directDesActions(e))) };
}
