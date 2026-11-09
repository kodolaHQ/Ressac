import type { Execution } from "./executions.js";
import type { WorkflowValide } from "./valider.js";

export const PREFIXE_REJEU = "Rejeu impossible : ";
/** Refusal when a replay's start line exceeds 4 MB (measured by `debutTropGros`, before any launch). */
export const REJEU_TROP_GROS = `${PREFIXE_REJEU}les sorties à reprendre dépassent 4 Mo`;

export type PlanRejeu =
  | { ok: true; relances: string[]; sorties: Record<string, unknown>; repris: Record<string, number | null>; origine: string }
  | { ok: false; erreur: string };

/** How many runs a replay goes back at most to find a taken output (try of a try of a try…). */
export const PROFONDEUR_REJEU = 8;

/**
 * What a replay from `depart` reruns (the block and all its descendants, in run order) and what it
 * takes from the original run (the output of the predecessors of the rerun blocks that are not rerun themselves). When
 * the origin is a try, its `repris` blocks have no output: it is taken from `anterieures`, the chain of its
 * origins (`anterieures[0]` is `origine.essai.origine`, and so on). The plan's `origine` names the run all
 * the taken outputs come from when there is only one, otherwise the given origin. Pure: no file
 * read, the size of what is taken is measured separately (`debutTropGros`).
 */
export function planRejeu(valide: WorkflowValide, origine: Execution | null, depart: string, anterieures: Execution[] = []): PlanRejeu {
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
  const chaine = [origine, ...anterieures].slice(0, PROFONDEUR_REJEU);
  const sources = new Set<string>();
  for (const id of valide.ordre.filter((b) => amont.has(b))) {
    let trace: Execution["blocs"][number] | undefined;
    for (const e of chaine) {
      trace = e.blocs.find((b) => b.id === id);
      if (trace?.statut !== "repris" || !e.essai) {
        if (trace) sources.add(e.id);
        break;
      }
    }
    if (!trace || (trace.statut !== "reussi" && trace.statut !== "partiel")) return refus(`la sortie de « ${id} » manque dans cette exécution`);
    if (trace.sortieTronquee) return refus(`la sortie de « ${id} » a été tronquée dans cette exécution`);
    if (trace.sortie === undefined) return refus(`la sortie de « ${id} » manque dans cette exécution`);
    sorties[id] = trace.sortie;
    repris[id] = trace.elements;
  }
  return { ok: true, relances, sorties, repris, origine: sources.size === 1 ? [...sources][0]! : origine.id };
}
