import { BLOCK_REGISTRY } from "./blocks/index.js";
import type { ValidWorkflow } from "./validate.js";

// The same rule is copied into the container's interpreter (docker/moteur): a test checks that they agree.

/**
 * The "as-it-goes" chain: the blocks each item goes through alone up to the output, in run
 * order. Empty if the output does not publish as it goes or does not have exactly one predecessor.
 *
 * Going up from the output's predecessor, a block is taken as long as it is chainable (`chaine` and
 * `parElement` true) and has only one successor (the block taken just before, or the output); we go up through its only
 * predecessor, and stop after it if it has several. Finally, blocks are removed at the start as long as the rest
 * is not a contiguous slice of the run order. A try has no chain: it is up to the caller to judge.
 */
export function streamingChain(v: ValidWorkflow): string[] {
  const blocks = new Map(v.workflow.blocks.map((b) => [b.id, b]));
  if (blocks.get(v.output.id)?.params.auFilDeLEau !== true) return [];
  const upstream = v.predecessors[v.output.id]!;
  if (upstream.length !== 1) return [];

  const successors = new Map<string, string[]>();
  for (const [id, preds] of Object.entries(v.predecessors)) {
    for (const p of preds) successors.set(p, [...(successors.get(p) ?? []), id]);
  }

  const chain: string[] = [];
  let next = v.output.id;
  let current: string | undefined = upstream[0];
  while (current !== undefined) {
    const b = blocks.get(current)!;
    if (BLOCK_REGISTRY.get(b.type)?.chain !== true || b.params.parElement !== true) break;
    const after = successors.get(current) ?? [];
    if (after.length !== 1 || after[0] !== next) break;
    chain.unshift(current);
    const before: string[] = v.predecessors[current]!;
    if (before.length !== 1) break;
    next = current;
    current = before[0];
  }

  while (chain.length > 0) {
    const start = v.order.indexOf(chain[0]!);
    if (chain.every((id, i) => v.order[start + i] === id)) break;
    chain.shift();
  }
  return chain;
}
