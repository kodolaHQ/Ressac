import type { Execution } from "./executions.js";
import type { WorkflowValide } from "./valider.js";

export const PREFIXE_REJEU = "Rejeu impossible : ";
/** Refus quand la ligne de début d'un rejeu dépasse 4 Mo (mesurée par `debutTropGros`, avant tout lancement). */
export const REJEU_TROP_GROS = `${PREFIXE_REJEU}les sorties à reprendre dépassent 4 Mo`;

export type PlanRejeu =
  | { ok: true; relances: string[]; sorties: Record<string, unknown>; repris: Record<string, number | null> }
  | { ok: false; erreur: string };

/**
 * Ce qu'un rejeu depuis `depart` relance (le bloc et tous ses descendants, dans l'ordre d'exécution) et ce qu'il
 * reprend de l'exécution d'origine (la sortie des prédécesseurs des blocs relancés qui ne le sont pas). Pur : aucune
 * lecture de fichier, la taille de ce qui est repris se mesure à part (`debutTropGros`).
 */
export function planRejeu(valide: WorkflowValide, origine: Execution | null, depart: string): PlanRejeu {
  const refus = (cause: string): PlanRejeu => ({ ok: false, erreur: PREFIXE_REJEU + cause });
  if (!origine) return refus("exécution introuvable");
  if (!valide.ordre.includes(depart)) return refus(`le bloc « ${depart} » n'est pas dans le workflow`);

  const suivants = new Map<string, string[]>();
  for (const l of valide.workflow.liens) suivants.set(l.de, [...(suivants.get(l.de) ?? []), l.vers]);
  const atteints = new Set<string>([depart]);
  const pile = [depart];
  while (pile.length) for (const s of suivants.get(pile.pop()!) ?? []) if (!atteints.has(s)) (atteints.add(s), pile.push(s));
  const relances = valide.ordre.filter((id) => atteints.has(id));

  const amont = new Set<string>();
  for (const id of relances) for (const p of valide.predecesseurs[id] ?? []) if (!atteints.has(p)) amont.add(p);

  const sorties: Record<string, unknown> = {};
  const repris: Record<string, number | null> = {};
  for (const id of valide.ordre.filter((b) => amont.has(b))) {
    const trace = origine.blocs.find((b) => b.id === id);
    if (!trace || (trace.statut !== "reussi" && trace.statut !== "partiel")) return refus(`la sortie de « ${id} » manque dans cette exécution`);
    if (trace.sortieTronquee) return refus(`la sortie de « ${id} » a été tronquée dans cette exécution`);
    if (trace.sortie === undefined) return refus(`la sortie de « ${id} » manque dans cette exécution`);
    sorties[id] = trace.sortie;
    repris[id] = trace.elements;
  }
  return { ok: true, relances, sorties, repris };
}
