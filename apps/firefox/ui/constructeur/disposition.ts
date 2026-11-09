import type { Brouillon } from "./brouillon";

export const COLONNE_PX = 260;
export const RANGEE_PX = 110;
type Position = { x: number; y: number };

/** Au moins deux blocs, tous à la même position : le fichier n'a jamais été disposé. */
export function sansDisposition(b: Brouillon): boolean {
  if (b.blocs.length < 2) return false;
  const { x, y } = b.blocs[0]!.position;
  return b.blocs.every((p) => p.position.x === x && p.position.y === y);
}

/** Colonne de chaque bloc : plus long chemin depuis une racine, liens fermant un cycle ignorés. */
function colonnes(b: Brouillon): Map<string, number> {
  const ids = new Set(b.blocs.map((x) => x.id));
  const suivants = new Map<string, string[]>();
  for (const l of b.liens) if (ids.has(l.de) && ids.has(l.vers) && l.de !== l.vers) suivants.set(l.de, [...(suivants.get(l.de) ?? []), l.vers]);
  // Parcours en profondeur : un lien vers un bloc en cours de visite ferme un cycle.
  const etat = new Map<string, 1 | 2>();
  const retenus = new Map<string, string[]>();
  const ordre: string[] = [];
  const visiter = (id: string) => {
    etat.set(id, 1);
    for (const s of suivants.get(id) ?? []) {
      if (etat.get(s) === 1) continue;
      retenus.set(id, [...(retenus.get(id) ?? []), s]);
      if (!etat.has(s)) visiter(s);
    }
    etat.set(id, 2);
    ordre.push(id);
  };
  const aPredecesseur = new Set(b.liens.filter((l) => ids.has(l.de) && ids.has(l.vers) && l.de !== l.vers).map((l) => l.vers));
  for (const x of b.blocs) if (!aPredecesseur.has(x.id) && !etat.has(x.id)) visiter(x.id);
  for (const x of b.blocs) if (!etat.has(x.id)) visiter(x.id);
  const col = new Map<string, number>(b.blocs.map((x) => [x.id, 0]));
  for (const id of ordre.reverse()) for (const s of retenus.get(id) ?? []) col.set(s, Math.max(col.get(s)!, col.get(id)! + 1));
  return col;
}

export function disposer(b: Brouillon): Record<string, Position> {
  const col = colonnes(b);
  const rang = new Map<number, number>();
  const sortie: Record<string, Position> = {};
  for (const x of b.blocs) {
    const c = col.get(x.id)!;
    const r = rang.get(c) ?? 0;
    rang.set(c, r + 1);
    sortie[x.id] = { x: c * COLONNE_PX, y: r * RANGEE_PX };
  }
  return sortie;
}

export function positionsAffichees(b: Brouillon, precedentes: Record<string, Position> | null): Record<string, Position> {
  if (sansDisposition(b)) {
    const auto = disposer(b);
    if (precedentes) for (const x of b.blocs) { const q = precedentes[x.id]; if (q) auto[x.id] = q; }
    return auto;
  }
  const sortie: Record<string, Position> = Object.fromEntries(b.blocs.map((x) => [x.id, { ...x.position }]));
  const place = (id: string): Position => sortie[id]!;
  if (!precedentes) return sortie;
  const nouveaux = b.blocs.filter((x) => !precedentes[x.id] && x.position.x === 0 && x.position.y === 0);
  if (nouveaux.length === 0 || nouveaux.length === b.blocs.length) return sortie;
  const col = colonnes(b);
  const enAttente = new Set(nouveaux.map((x) => x.id));
  for (const n of nouveaux) {
    const x = col.get(n.id)! * COLONNE_PX;
    let y = 0;
    for (const o of b.blocs) if (o.id !== n.id && !enAttente.has(o.id) && place(o.id).x === x) y = Math.max(y, place(o.id).y + RANGEE_PX);
    sortie[n.id] = { x, y };
    enAttente.delete(n.id);
  }
  return sortie;
}
