import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { writePrivateJson } from "../design/atomic-write.js";
import type { DiffFile } from "./repo.js";
import { newPosition, type Block } from "./diff.js";

/** Re-exported by design/remarques.ts (task 5), which does not redefine it. */
export const EMPTY_REMARK = "Une remarque vide n'est pas acceptée.";

export interface Comment {
  id: string; fichier: string; debut: number; fin: number;
  lignes: { marque: " " | "+" | "-"; texte: string }[];
  texte: string; cree: string; envoye: boolean; resolu: boolean; ligneChangee: boolean;
}

const Schema = z.array(z.object({
  id: z.string(), fichier: z.string(), debut: z.number(), fin: z.number(),
  lignes: z.array(z.object({ marque: z.enum([" ", "+", "-"]), texte: z.string() })),
  texte: z.string(), cree: z.string(), envoye: z.boolean(), resolu: z.boolean(), ligneChangee: z.boolean(),
}));

interface Shown { marque: " " | "+" | "-"; texte: string; position: number; bloc: number; indice: number }

function shownList(blocks: Block[]): Shown[] {
  return blocks.flatMap((b, block) => b.lignes.map((l, hint) => ({ marque: l.marque, texte: l.texte, position: newPosition(b, hint), bloc: block, indice: hint })));
}

function nearest<T>(items: T[], pos: (t: T) => number, target: number): T {
  return items.reduce((m, t) => (Math.abs(pos(t) - target) < Math.abs(pos(m) - target) ? t : m));
}

/** Pure re-anchoring: a comment is never deleted, only moved or marked « ligne changée ». */
export function rejoin(c: Comment, blocks: Block[]): Comment {
  const lignes = shownList(blocks);
  const n = c.lignes.length;
  const windows: Shown[][] = [];
  if (n > 0) {
    for (let i = 0; i + n <= lignes.length; i++) {
      const f = lignes.slice(i, i + n);
      // The text alone: a « + » line becomes context again after « Marquer comme relu ».
      if (f.every((l, k) => l.bloc === f[0]!.bloc && l.texte === c.lignes[k]!.texte)) windows.push(f);
    }
  }
  if (windows.length > 0) {
    const f = nearest(windows, (w) => w[0]!.position, c.debut);
    return { ...c, debut: f[0]!.position, fin: f[n - 1]!.position, ligneChangee: false };
  }
  const sameText = n > 0 ? lignes.filter((l) => l.texte === c.lignes[0]!.texte) : [];
  if (sameText.length > 0) {
    const l = nearest(sameText, (x) => x.position, c.debut);
    return { ...c, debut: l.position, fin: l.position, ligneChangee: true };
  }
  if (lignes.length > 0) {
    const l = nearest(lignes, (x) => x.position, c.debut);
    return { ...c, debut: l.position, fin: l.position, ligneChangee: true };
  }
  return { ...c, ligneChangee: true };
}

export class ReviewComments {
  private ecritures: Promise<unknown> = Promise.resolve();

  constructor(private readonly fichier: string) {}

  private async lire(): Promise<Comment[]> {
    let raw: string;
    try { raw = await readFile(this.fichier, "utf8"); } catch { return []; }
    try { return Schema.parse(JSON.parse(raw)); } catch { return []; }
  }

  // Serialized read-modify-write: two simultaneous calls do not overwrite each other.
  private transformer<T>(f: (list: Comment[]) => { liste: Comment[]; resultat: T }): Promise<T> {
    const tache = this.ecritures.then(async () => {
      const { liste: list, resultat: result } = f(await this.lire());
      await writePrivateJson(this.fichier, list);
      return result;
    });
    this.ecritures = tache.catch(() => undefined);
    return tache;
  }

  async liste(): Promise<Comment[]> {
    await this.ecritures;
    return this.lire();
  }

  ajouter(c: Pick<Comment, "fichier" | "debut" | "fin" | "lignes" | "texte">): Promise<Comment> {
    if (c.texte.trim() === "") return Promise.reject(new Error(EMPTY_REMARK));
    return this.transformer((list) => {
      const fresh: Comment = {
        id: `c-${randomBytes(4).toString("hex")}`, fichier: c.fichier, debut: c.debut, fin: c.fin,
        lignes: c.lignes.map((l) => ({ marque: l.marque, texte: l.texte })), texte: c.texte,
        cree: new Date().toISOString(), envoye: false, resolu: false, ligneChangee: false,
      };
      return { liste: [...list, fresh], resultat: fresh };
    });
  }

  modifier(id: string, text: string): Promise<void> {
    if (text.trim() === "") return Promise.reject(new Error(EMPTY_REMARK));
    return this.transformer((list) => ({ liste: list.map((c) => (c.id === id ? { ...c, texte: text, envoye: false } : c)), resultat: undefined }));
  }

  resoudre(id: string, resolved: boolean): Promise<void> {
    return this.transformer((list) => ({ liste: list.map((c) => (c.id === id ? { ...c, resolu: resolved } : c)), resultat: undefined }));
  }

  supprimer(id: string): Promise<void> {
    return this.transformer((list) => ({ liste: list.filter((c) => c.id !== id), resultat: undefined }));
  }

  recollerFichier(path: string, diff: DiffFile | null): Promise<Comment[]> {
    return this.transformer((list) => {
      const next = list.map((c) => (c.fichier !== path ? c : diff ? rejoin(c, diff.blocs) : { ...c, ligneChangee: true }));
      return { liste: next, resultat: next.filter((c) => c.fichier === path) };
    });
  }

  async aEnvoyer(): Promise<Comment[]> {
    return (await this.liste()).filter((c) => !c.resolu);
  }

  marquerEnvoyes(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    return this.transformer((list) => ({ liste: list.map((c) => (idSet.has(c.id) ? { ...c, envoye: true } : c)), resultat: undefined }));
  }

  /** Marks as sent those whose text is still the one that left (a change in the meantime stays to be sent). */
  marquerEnvoyesSiInchanges(sent: { id: string; texte: string }[]): Promise<void> {
    const texts = new Map(sent.map((e) => [e.id, e.texte]));
    return this.transformer((list) => ({
      liste: list.map((c) => (texts.get(c.id) === c.texte ? { ...c, envoye: true } : c)),
      resultat: undefined,
    }));
  }

  apresRelu(): Promise<void> {
    return this.transformer((list) => ({ liste: list.filter((c) => !c.resolu), resultat: undefined }));
  }
}
