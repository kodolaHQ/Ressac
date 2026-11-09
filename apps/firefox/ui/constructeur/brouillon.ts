import type { Draft } from "../../shared/api";

export type { Draft as Brouillon };
type BlocBrouillon = Draft["blocs"][number];
type Position = { x: number; y: number };

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Lenient reading of a `workflow.json` (or its received copy); null if the blocks are unusable. */
export function versBrouillon(brut: unknown): Draft | null {
  if (!estObjet(brut) || !Array.isArray(brut.blocs)) return null;
  const blocs: BlocBrouillon[] = [];
  for (const b of brut.blocs) {
    if (!estObjet(b) || typeof b.id !== "string" || typeof b.type !== "string") return null;
    const p = estObjet(b.position) ? b.position : {};
    const bloc: BlocBrouillon = {
      id: b.id,
      type: b.type,
      position: { x: typeof p.x === "number" && Number.isFinite(p.x) ? p.x : 0, y: typeof p.y === "number" && Number.isFinite(p.y) ? p.y : 0 },
      parametres: estObjet(b.parametres) ? b.parametres : {},
    };
    if (typeof b.nom === "string") bloc.nom = b.nom;
    blocs.push(bloc);
  }
  const liens = Array.isArray(brut.liens)
    ? brut.liens.flatMap((l) => (estObjet(l) && typeof l.de === "string" && typeof l.vers === "string" ? [{ de: l.de, vers: l.vers }] : []))
    : [];
  return { version: 1, blocs, liens };
}

/** `ia.trier` → `ia-trier`, then `ia-trier-2`, … (40 characters at most). */
export function idPourType(type: string, existants: Iterable<string>): string {
  const pris = new Set(existants);
  const base = type.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "bloc";
  const coupe = (s: string, suffixe: string) => s.slice(0, 40 - suffixe.length).replace(/-+$/, "") + suffixe;
  let id = coupe(base, "");
  for (let n = 2; pris.has(id); n++) id = coupe(base, `-${n}`);
  return id;
}

export function ajouterBloc(b: Draft, type: string, position: Position, parametres: Record<string, unknown>): { brouillon: Draft; id: string } {
  if (type === "sortie" && b.blocs.some((x) => x.type === "sortie")) return { brouillon: b, id: "" };
  const id = idPourType(type, b.blocs.map((x) => x.id));
  return { brouillon: { ...b, blocs: [...b.blocs, { id, type, position: { ...position }, parametres }] }, id };
}

export function relier(b: Draft, de: string, vers: string): Draft {
  if (de === vers) return b;
  if (b.liens.some((l) => l.de === de && l.vers === vers)) return b;
  const ids = new Set(b.blocs.map((x) => x.id));
  if (!ids.has(de) || !ids.has(vers)) return b;
  if (b.blocs.find((x) => x.id === de)!.type === "sortie") return b;
  return { ...b, liens: [...b.liens, { de, vers }] };
}

export function supprimerBlocs(b: Draft, ids: Iterable<string>): Draft {
  const supprimables = new Set(b.blocs.filter((x) => x.type !== "sortie").map((x) => x.id));
  const a = new Set([...ids].filter((i) => supprimables.has(i)));
  if (a.size === 0) return b;
  return { ...b, blocs: b.blocs.filter((x) => !a.has(x.id)), liens: b.liens.filter((l) => !a.has(l.de) && !a.has(l.vers)) };
}

export function supprimerLien(b: Draft, de: string, vers: string): Draft {
  const liens = b.liens.filter((l) => !(l.de === de && l.vers === vers));
  return liens.length === b.liens.length ? b : { ...b, liens };
}

/** Returns `b` itself when no position really changes (a click writes nothing). */
export function deplacer(b: Draft, positions: Record<string, Position>): Draft {
  let change = false;
  const blocs = b.blocs.map((x) => {
    const p = positions[x.id];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || (p.x === x.position.x && p.y === x.position.y)) return x;
    change = true;
    return { ...x, position: { x: p.x, y: p.y } };
  });
  return change ? { ...b, blocs } : b;
}

export function regler(b: Draft, id: string, parametres: Record<string, unknown>): Draft {
  if (!b.blocs.some((x) => x.id === id)) return b;
  return { ...b, blocs: b.blocs.map((x) => (x.id === id ? { ...x, parametres } : x)) };
}

export function renommer(b: Draft, id: string, nom: string): Draft {
  if (!b.blocs.some((x) => x.id === id)) return b;
  return {
    ...b,
    blocs: b.blocs.map((x) => {
      if (x.id !== id) return x;
      const { nom: _ancien, ...reste } = x;
      return nom === "" ? reste : { ...reste, nom: nom.slice(0, 60) };
    }),
  };
}

function canonique(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonique);
  if (estObjet(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonique(v[k])]));
  return v;
}
export const memeBrouillon = (a: Draft, b: Draft): boolean => JSON.stringify(canonique(a)) === JSON.stringify(canonique(b));

/** Stack of states for undo / redo; at most `max` states, the current one included. */
export class Historique {
  courant: Draft;
  private passe: Draft[] = [];
  private futur: Draft[] = [];
  /** Merge key of the last made state: a state made with the same key replaces it (keystrokes of the same field). */
  private fusion: string | null = null;
  constructor(initial: Draft, private readonly max = 100) {
    this.courant = initial;
  }
  faire(b: Draft, fusion?: string): void {
    if (b === this.courant || memeBrouillon(b, this.courant)) return;
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
    const avant = this.passe.pop();
    if (!avant) return null;
    this.futur.push(this.courant);
    this.courant = avant;
    return avant;
  }
  retablir(): Draft | null {
    this.fusion = null;
    const apres = this.futur.pop();
    if (!apres) return null;
    this.passe.push(this.courant);
    this.courant = apres;
    return apres;
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
export function suivreFichier(o: { local: Draft; dernierConnu: Draft | null; disque: Draft | null; envoyes?: Draft[] }): "ignorer" | "adopter" | "proposer" | "illisible" {
  const { local, dernierConnu, disque } = o;
  if (!disque) return "illisible";
  if (memeBrouillon(disque, local)) return "ignorer";
  if (dernierConnu && memeBrouillon(disque, dernierConnu)) return "ignorer";
  if ((o.envoyes ?? []).some((e) => memeBrouillon(disque, e))) return "ignorer";
  if (dernierConnu && memeBrouillon(local, dernierConnu)) return "adopter";
  return "proposer";
}
