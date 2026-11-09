import type { Draft } from "../../shared/api";

export type { Draft };
type DraftBlock = Draft["blocks"][number];
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
      params: isObject(b.parametres) ? b.parametres : {},
    };
    if (typeof b.nom === "string") block.name = b.nom;
    blocks.push(block);
  }
  const links = Array.isArray(raw.liens)
    ? raw.liens.flatMap((l) => (isObject(l) && typeof l.de === "string" && typeof l.vers === "string" ? [{ from: l.de, to: l.vers }] : []))
    : [];
  return { version: 1, blocks: blocks, links };
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

export function addBlock(b: Draft, type: string, position: Position, params: Record<string, unknown>): { draft: Draft; id: string } {
  if (type === "sortie" && b.blocks.some((x) => x.type === "sortie")) return { draft: b, id: "" };
  const id = idForType(type, b.blocks.map((x) => x.id));
  return { draft: { ...b, blocks: [...b.blocks, { id, type, position: { ...position }, params: params }] }, id };
}

export function link(b: Draft, from: string, to: string): Draft {
  if (from === to) return b;
  if (b.links.some((l) => l.from === from && l.to === to)) return b;
  const ids = new Set(b.blocks.map((x) => x.id));
  if (!ids.has(from) || !ids.has(to)) return b;
  if (b.blocks.find((x) => x.id === from)!.type === "sortie") return b;
  return { ...b, links: [...b.links, { from: from, to: to }] };
}

export function deleteBlocks(b: Draft, ids: Iterable<string>): Draft {
  const deletable = new Set(b.blocks.filter((x) => x.type !== "sortie").map((x) => x.id));
  const a = new Set([...ids].filter((i) => deletable.has(i)));
  if (a.size === 0) return b;
  return { ...b, blocks: b.blocks.filter((x) => !a.has(x.id)), links: b.links.filter((l) => !a.has(l.from) && !a.has(l.to)) };
}

export function deleteLink(b: Draft, from: string, to: string): Draft {
  const links = b.links.filter((l) => !(l.from === from && l.to === to));
  return links.length === b.links.length ? b : { ...b, links };
}

/** Returns `b` itself when no position really changes (a click writes nothing). */
export function move(b: Draft, positions: Record<string, Position>): Draft {
  let change = false;
  const blocks = b.blocks.map((x) => {
    const p = positions[x.id];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || (p.x === x.position.x && p.y === x.position.y)) return x;
    change = true;
    return { ...x, position: { x: p.x, y: p.y } };
  });
  return change ? { ...b, blocks: blocks } : b;
}

export function set(b: Draft, id: string, params: Record<string, unknown>): Draft {
  if (!b.blocks.some((x) => x.id === id)) return b;
  return { ...b, blocks: b.blocks.map((x) => (x.id === id ? { ...x, params: params } : x)) };
}

export function rename(b: Draft, id: string, name: string): Draft {
  if (!b.blocks.some((x) => x.id === id)) return b;
  return {
    ...b,
    blocks: b.blocks.map((x) => {
      if (x.id !== id) return x;
      const { name: _old, ...rest } = x;
      return name === "" ? rest : { ...rest, name: name.slice(0, 60) };
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
  current: Draft;
  private past: Draft[] = [];
  private future: Draft[] = [];
  /** Merge key of the last made state: a state made with the same key replaces it (keystrokes of the same field). */
  private merge: string | null = null;
  constructor(initial: Draft, private readonly max = 100) {
    this.current = initial;
  }
  do(b: Draft, fusion?: string): void {
    if (b === this.current || sameDraft(b, this.current)) return;
    if (fusion === undefined || fusion !== this.merge || this.past.length === 0) {
      this.past.push(this.current);
      if (this.past.length >= this.max) this.past.shift();
    }
    this.merge = fusion ?? null;
    this.future = [];
    this.current = b;
  }
  cancel(): Draft | null {
    this.merge = null;
    const before = this.past.pop();
    if (!before) return null;
    this.future.push(this.current);
    this.current = before;
    return before;
  }
  restore(): Draft | null {
    this.merge = null;
    const after = this.future.pop();
    if (!after) return null;
    this.past.push(this.current);
    this.current = after;
    return after;
  }
  reset(b: Draft): void {
    this.merge = null;
    this.current = b;
    this.past = [];
    this.future = [];
  }
}

/**
 * What to do when `workflow.json` changes on disk?
 * `envoyes`: drafts sent for saving and not yet confirmed (their echo is ignored).
 */
export function followFile(o: { local: Draft; lastKnown: Draft | null; disk: Draft | null; sent?: Draft[] }): "ignorer" | "adopter" | "proposer" | "illisible" {
  const { local, lastKnown: lastKnown, disk: disk } = o;
  if (!disk) return "illisible";
  if (sameDraft(disk, local)) return "ignorer";
  if (lastKnown && sameDraft(disk, lastKnown)) return "ignorer";
  if ((o.sent ?? []).some((e) => sameDraft(disk, e))) return "ignorer";
  if (lastKnown && sameDraft(local, lastKnown)) return "adopter";
  return "proposer";
}
