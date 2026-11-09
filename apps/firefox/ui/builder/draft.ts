import type { Draft } from "../../shared/api";

export type { Draft };
type DraftBlock = Draft["blocs"][number];
type Position = { x: number; y: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Lenient reading of a `workflow.json` (or its received copy); null if the blocks are unusable. */
export function toDraft(raw: unknown): Draft | null {
  if (!isObject(raw) || !Array.isArray(raw.blocs)) return null;
  const blocks: DraftBlock[] = [];
  for (const b of raw.blocs) {
    if (!isObject(b) || typeof b.id !== "string" || typeof b.type !== "string") return null;
    const p = isObject(b.position) ? b.position : {};
    const block: DraftBlock = {
      id: b.id,
      type: b.type,
      position: { x: typeof p.x === "number" && Number.isFinite(p.x) ? p.x : 0, y: typeof p.y === "number" && Number.isFinite(p.y) ? p.y : 0 },
      parametres: isObject(b.parametres) ? b.parametres : {},
    };
    if (typeof b.nom === "string") block.nom = b.nom;
    blocks.push(block);
  }
  const liens = Array.isArray(raw.liens)
    ? raw.liens.flatMap((l) => (isObject(l) && typeof l.de === "string" && typeof l.vers === "string" ? [{ de: l.de, vers: l.vers }] : []))
    : [];
  return { version: 1, blocs: blocks, liens };
}

/** `ia.trier` → `ia-trier`, then `ia-trier-2`, … (40 characters at most). */
export function idForType(type: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = type.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "bloc";
  const cut = (s: string, suffix: string) => s.slice(0, 40 - suffix.length).replace(/-+$/, "") + suffix;
  let id = cut(base, "");
  for (let n = 2; taken.has(id); n++) id = cut(base, `-${n}`);
  return id;
}

export function addBlock(b: Draft, type: string, position: Position, params: Record<string, unknown>): { brouillon: Draft; id: string } {
  if (type === "sortie" && b.blocs.some((x) => x.type === "sortie")) return { brouillon: b, id: "" };
  const id = idForType(type, b.blocs.map((x) => x.id));
  return { brouillon: { ...b, blocs: [...b.blocs, { id, type, position: { ...position }, parametres: params }] }, id };
}

export function link(b: Draft, from: string, to: string): Draft {
  if (from === to) return b;
  if (b.liens.some((l) => l.de === from && l.vers === to)) return b;
  const ids = new Set(b.blocs.map((x) => x.id));
  if (!ids.has(from) || !ids.has(to)) return b;
  if (b.blocs.find((x) => x.id === from)!.type === "sortie") return b;
  return { ...b, liens: [...b.liens, { de: from, vers: to }] };
}

export function deleteBlocks(b: Draft, ids: Iterable<string>): Draft {
  const deletable = new Set(b.blocs.filter((x) => x.type !== "sortie").map((x) => x.id));
  const a = new Set([...ids].filter((i) => deletable.has(i)));
  if (a.size === 0) return b;
  return { ...b, blocs: b.blocs.filter((x) => !a.has(x.id)), liens: b.liens.filter((l) => !a.has(l.de) && !a.has(l.vers)) };
}

export function deleteLink(b: Draft, from: string, to: string): Draft {
  const liens = b.liens.filter((l) => !(l.de === from && l.vers === to));
  return liens.length === b.liens.length ? b : { ...b, liens };
}

/** Returns `b` itself when no position really changes (a click writes nothing). */
export function move(b: Draft, positions: Record<string, Position>): Draft {
  let change = false;
  const blocks = b.blocs.map((x) => {
    const p = positions[x.id];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || (p.x === x.position.x && p.y === x.position.y)) return x;
    change = true;
    return { ...x, position: { x: p.x, y: p.y } };
  });
  return change ? { ...b, blocs: blocks } : b;
}

export function set(b: Draft, id: string, params: Record<string, unknown>): Draft {
  if (!b.blocs.some((x) => x.id === id)) return b;
  return { ...b, blocs: b.blocs.map((x) => (x.id === id ? { ...x, parametres: params } : x)) };
}

export function rename(b: Draft, id: string, name: string): Draft {
  if (!b.blocs.some((x) => x.id === id)) return b;
  return {
    ...b,
    blocs: b.blocs.map((x) => {
      if (x.id !== id) return x;
      const { nom: _old, ...rest } = x;
      return name === "" ? rest : { ...rest, nom: name.slice(0, 60) };
    }),
  };
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
export const sameDraft = (a: Draft, b: Draft): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Stack of states for undo / redo; at most `max` states, the current one included. */
export class History {
  courant: Draft;
  private passe: Draft[] = [];
  private futur: Draft[] = [];
  /** Merge key of the last made state: a state made with the same key replaces it (keystrokes of the same field). */
  private fusion: string | null = null;
  constructor(initial: Draft, private readonly max = 100) {
    this.courant = initial;
  }
  faire(b: Draft, fusion?: string): void {
    if (b === this.courant || sameDraft(b, this.courant)) return;
    if (fusion === undefined || fusion !== this.fusion || this.passe.length === 0) {
      this.passe.push(this.courant);
      if (this.passe.length >= this.max) this.passe.shift();
    }
    this.fusion = fusion ?? null;
    this.futur = [];
    this.courant = b;
  }
  annuler(): Draft | null {
    this.fusion = null;
    const before = this.passe.pop();
    if (!before) return null;
    this.futur.push(this.courant);
    this.courant = before;
    return before;
  }
  retablir(): Draft | null {
    this.fusion = null;
    const after = this.futur.pop();
    if (!after) return null;
    this.passe.push(this.courant);
    this.courant = after;
    return after;
  }
  reinitialiser(b: Draft): void {
    this.fusion = null;
    this.courant = b;
    this.passe = [];
    this.futur = [];
  }
}

/**
 * What to do when `workflow.json` changes on disk?
 * `envoyes`: drafts sent for saving and not yet confirmed (their echo is ignored).
 */
export function followFile(o: { local: Draft; dernierConnu: Draft | null; disque: Draft | null; envoyes?: Draft[] }): "ignorer" | "adopter" | "proposer" | "illisible" {
  const { local, dernierConnu: lastKnown, disque: disk } = o;
  if (!disk) return "illisible";
  if (sameDraft(disk, local)) return "ignorer";
  if (lastKnown && sameDraft(disk, lastKnown)) return "ignorer";
  if ((o.envoyes ?? []).some((e) => sameDraft(disk, e))) return "ignorer";
  if (lastKnown && sameDraft(local, lastKnown)) return "adopter";
  return "proposer";
}
