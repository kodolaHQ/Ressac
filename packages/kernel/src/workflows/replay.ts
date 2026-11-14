import { say } from "../i18n.js";
import type { Execution } from "./executions.js";
import type { ValidWorkflow } from "./validate.js";

/** Refusal when a replay's start line exceeds 4 MB (measured by `startTooBig`, before any launch). */
export const REPLAY_TOO_BIG = (locale: string) => say(locale, "kernel-replay-too-big");

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
export function replayPlan(valid: ValidWorkflow, origin: Execution | null, start: string, earlier: Execution[] = [], locale = "en"): ReplayPlan {
  const denial = (id: string, block?: string): ReplayPlan => ({ ok: false, error: say(locale, id, { id: block ?? "" }) });
  if (!origin) return denial("kernel-replay-not-found");
  if (!valid.order.includes(start)) return denial("kernel-replay-block-absent", start);

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
    if (!trace || (trace.status !== "succeeded" && trace.status !== "partial")) return denial("kernel-replay-output-missing", id);
    if (trace.outputTruncated) return denial("kernel-replay-output-truncated", id);
    if (trace.output === undefined) return denial("kernel-replay-output-missing", id);
    outputs[id] = trace.output;
    resumed[id] = trace.items;
  }
  return { ok: true, reruns: relaunches, outputs, resumed: resumed, origin: sources.size === 1 ? [...sources][0]! : origin.id };
}
