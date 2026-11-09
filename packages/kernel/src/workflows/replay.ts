import type { Execution } from "./executions.js";
import type { ValidWorkflow } from "./validate.js";

export const REPLAY_PREFIX = "Rejeu impossible : ";
/** Refusal when a replay's start line exceeds 4 MB (measured by `debutTropGros`, before any launch). */
export const REPLAY_TOO_BIG = `${REPLAY_PREFIX}les sorties à reprendre dépassent 4 Mo`;

export type ReplayPlan =
  | { ok: true; relances: string[]; sorties: Record<string, unknown>; repris: Record<string, number | null>; origine: string }
  | { ok: false; erreur: string };

/** How many runs a replay goes back at most to find a taken output (try of a try of a try…). */
export const REPLAY_DEPTH = 8;

/**
 * What a replay from `depart` reruns (the block and all its descendants, in run order) and what it
 * takes from the original run (the output of the predecessors of the rerun blocks that are not rerun themselves). When
 * the origin is a try, its `repris` blocks have no output: it is taken from `anterieures`, the chain of its
 * origins (`anterieures[0]` is `origine.essai.origine`, and so on). The plan's `origine` names the run all
 * the taken outputs come from when there is only one, otherwise the given origin. Pure: no file
 * read, the size of what is taken is measured separately (`debutTropGros`).
 */
export function replayPlan(valid: ValidWorkflow, origin: Execution | null, depart: string, earlier: Execution[] = []): ReplayPlan {
  const denial = (cause: string): ReplayPlan => ({ ok: false, erreur: REPLAY_PREFIX + cause });
  if (!origin) return denial("exécution introuvable");
  if (!valid.ordre.includes(depart)) return denial(`le bloc « ${depart} » n'est pas dans le workflow`);

  const next = new Map<string, string[]>();
  for (const l of valid.workflow.liens) next.set(l.de, [...(next.get(l.de) ?? []), l.vers]);
  const reachedList = new Set<string>([depart]);
  const pile = [depart];
  while (pile.length) for (const s of next.get(pile.pop()!) ?? []) if (!reachedList.has(s)) (reachedList.add(s), pile.push(s));
  const relaunches = valid.ordre.filter((id) => reachedList.has(id));

  const upstream = new Set<string>();
  for (const id of relaunches) for (const p of valid.predecesseurs[id] ?? []) if (!reachedList.has(p)) upstream.add(p);

  const sorties: Record<string, unknown> = {};
  const resumed: Record<string, number | null> = {};
  const chain = [origin, ...earlier].slice(0, REPLAY_DEPTH);
  const sources = new Set<string>();
  for (const id of valid.ordre.filter((b) => upstream.has(b))) {
    let trace: Execution["blocs"][number] | undefined;
    for (const e of chain) {
      trace = e.blocs.find((b) => b.id === id);
      if (trace?.statut !== "repris" || !e.essai) {
        if (trace) sources.add(e.id);
        break;
      }
    }
    if (!trace || (trace.statut !== "reussi" && trace.statut !== "partiel")) return denial(`la sortie de « ${id} » manque dans cette exécution`);
    if (trace.sortieTronquee) return denial(`la sortie de « ${id} » a été tronquée dans cette exécution`);
    if (trace.sortie === undefined) return denial(`la sortie de « ${id} » manque dans cette exécution`);
    sorties[id] = trace.sortie;
    resumed[id] = trace.elements;
  }
  return { ok: true, relances: relaunches, sorties, repris: resumed, origine: sources.size === 1 ? [...sources][0]! : origin.id };
}
