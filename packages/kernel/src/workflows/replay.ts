import type { Execution } from "./executions.js";
import type { ValidWorkflow } from "./validate.js";

export const REPLAY_PREFIX = "Rejeu impossible : ";
/** Refusal when a replay's start line exceeds 4 MB (measured by `startTooBig`, before any launch). */
export const REPLAY_TOO_BIG = `${REPLAY_PREFIX}les sorties à reprendre dépassent 4 Mo`;

export type ReplayPlan =
  | { ok: true; reruns: string[]; outputs: Record<string, unknown>; resumed: Record<string, number | null>; origin: string }
  | { ok: false; error: string };

/** How many runs a replay goes back at most to find a taken output (try of a try of a try…). */
export const REPLAY_DEPTH = 8;

/**
 * What a replay from `depart` reruns (the block and all its descendants, in run order) and what it
 * takes from the original run (the output of the predecessors of the rerun blocks that are not rerun themselves). When
 * the origin is a try, its `resumed` blocks have no output: it is taken from `anterieures`, the chain of its
 * origins (`anterieures[0]` is `origine.essai.origine`, and so on). The plan's `origine` names the run all
 * the taken outputs come from when there is only one, otherwise the given origin. Pure: no file
 * read, the size of what is taken is measured separately (`startTooBig`).
 */
export function replayPlan(valid: ValidWorkflow, origin: Execution | null, start: string, earlier: Execution[] = []): ReplayPlan {
  const denial = (cause: string): ReplayPlan => ({ ok: false, error: REPLAY_PREFIX + cause });
  if (!origin) return denial("exécution introuvable");
  if (!valid.order.includes(start)) return denial(`le bloc « ${start} » n'est pas dans le workflow`);

  const next = new Map<string, string[]>();
  for (const l of valid.workflow.links) next.set(l.from, [...(next.get(l.from) ?? []), l.to]);
  const reachedList = new Set<string>([start]);
  const stack = [start];
  while (stack.length) for (const s of next.get(stack.pop()!) ?? []) if (!reachedList.has(s)) (reachedList.add(s), stack.push(s));
  const relaunches = valid.order.filter((id) => reachedList.has(id));

  const upstream = new Set<string>();
  for (const id of relaunches) for (const p of valid.predecessors[id] ?? []) if (!reachedList.has(p)) upstream.add(p);

  const outputs: Record<string, unknown> = {};
  const resumed: Record<string, number | null> = {};
  const chain = [origin, ...earlier].slice(0, REPLAY_DEPTH);
  const sources = new Set<string>();
  for (const id of valid.order.filter((b) => upstream.has(b))) {
    let trace: Execution["blocks"][number] | undefined;
    for (const e of chain) {
      trace = e.blocks.find((b) => b.id === id);
      if (trace?.status !== "resumed" || !e.attempt) {
        if (trace) sources.add(e.id);
        break;
      }
    }
    if (!trace || (trace.status !== "succeeded" && trace.status !== "partial")) return denial(`la sortie de « ${id} » manque dans cette exécution`);
    if (trace.outputTruncated) return denial(`la sortie de « ${id} » a été tronquée dans cette exécution`);
    if (trace.output === undefined) return denial(`la sortie de « ${id} » manque dans cette exécution`);
    outputs[id] = trace.output;
    resumed[id] = trace.items;
  }
  return { ok: true, reruns: relaunches, outputs, resumed: resumed, origin: sources.size === 1 ? [...sources][0]! : origin.id };
}
