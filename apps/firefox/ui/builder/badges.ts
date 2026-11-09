import type { DirectWidget } from "@webaios/kernel";

export type Badge = { status: string; items: number | null };

/**
 * Status of each block: the chosen run's (full or summarized), replaced by the live state for blocks in progress.
 */
export function badgesOf(execution: { blocks: { id: string; status: string; items: number | null }[] } | null, direct: DirectWidget | null): Record<string, Badge> {
  const output: Record<string, Badge> = {};
  for (const b of execution?.blocks ?? []) output[b.id] = { status: b.status, items: b.items };
  for (const [id, b] of Object.entries(direct?.blocks ?? {})) output[id] = { status: b.status, items: b.items };
  return output;
}
