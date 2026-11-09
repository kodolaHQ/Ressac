import type { Brouillon } from "./brouillon";

export const COLUMN_PX = 260;
export const ROW_PX = 110;
type Position = { x: number; y: number };

/** At least two blocks, all at the same position: the file was never laid out. */
export function sansDisposition(b: Brouillon): boolean {
  if (b.blocs.length < 2) return false;
  const { x, y } = b.blocs[0]!.position;
  return b.blocs.every((p) => p.position.x === x && p.position.y === y);
}

/** Column of each block: longest path from a root, links closing a cycle ignored. */
function columns(b: Brouillon): Map<string, number> {
  const ids = new Set(b.blocs.map((x) => x.id));
  const next = new Map<string, string[]>();
  for (const l of b.liens) if (ids.has(l.de) && ids.has(l.vers) && l.de !== l.vers) next.set(l.de, [...(next.get(l.de) ?? []), l.vers]);
  // Depth-first traversal: a link to a block being visited closes a cycle.
  const appState = new Map<string, 1 | 2>();
  const kept = new Map<string, string[]>();
  const order: string[] = [];
  const visiter = (id: string) => {
    appState.set(id, 1);
    for (const s of next.get(id) ?? []) {
      if (appState.get(s) === 1) continue;
      kept.set(id, [...(kept.get(id) ?? []), s]);
      if (!appState.has(s)) visiter(s);
    }
    appState.set(id, 2);
    order.push(id);
  };
  const hasPredecessor = new Set(b.liens.filter((l) => ids.has(l.de) && ids.has(l.vers) && l.de !== l.vers).map((l) => l.vers));
  for (const x of b.blocs) if (!hasPredecessor.has(x.id) && !appState.has(x.id)) visiter(x.id);
  for (const x of b.blocs) if (!appState.has(x.id)) visiter(x.id);
  const col = new Map<string, number>(b.blocs.map((x) => [x.id, 0]));
  for (const id of order.reverse()) for (const s of kept.get(id) ?? []) col.set(s, Math.max(col.get(s)!, col.get(id)! + 1));
  return col;
}

export function disposer(b: Brouillon): Record<string, Position> {
  const col = columns(b);
  const rang = new Map<number, number>();
  const sortie: Record<string, Position> = {};
  for (const x of b.blocs) {
    const c = col.get(x.id)!;
    const r = rang.get(c) ?? 0;
    rang.set(c, r + 1);
    sortie[x.id] = { x: c * COLUMN_PX, y: r * ROW_PX };
  }
  return sortie;
}

export function shownPositions(b: Brouillon, previous: Record<string, Position> | null): Record<string, Position> {
  if (sansDisposition(b)) {
    const auto = disposer(b);
    if (previous) for (const x of b.blocs) { const q = previous[x.id]; if (q) auto[x.id] = q; }
    return auto;
  }
  const sortie: Record<string, Position> = Object.fromEntries(b.blocs.map((x) => [x.id, { ...x.position }]));
  const place = (id: string): Position => sortie[id]!;
  if (!previous) return sortie;
  const fresh = b.blocs.filter((x) => !previous[x.id] && x.position.x === 0 && x.position.y === 0);
  if (fresh.length === 0 || fresh.length === b.blocs.length) return sortie;
  const col = columns(b);
  const pending = new Set(fresh.map((x) => x.id));
  for (const n of fresh) {
    const x = col.get(n.id)! * COLUMN_PX;
    let y = 0;
    for (const o of b.blocs) if (o.id !== n.id && !pending.has(o.id) && place(o.id).x === x) y = Math.max(y, place(o.id).y + ROW_PX);
    sortie[n.id] = { x, y };
    pending.delete(n.id);
  }
  return sortie;
}
