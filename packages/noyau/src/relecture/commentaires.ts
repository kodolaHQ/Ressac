import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ecrireJsonPrive } from "../design/ecriture-atomique.js";
import type { DiffFichier } from "./depot.js";
import { positionNouvelle, type Bloc } from "./diff.js";

/** Réexporté par design/remarques.ts (tâche 5), qui ne le redéfinit pas. */
export const REMARQUE_VIDE = "Une remarque vide n'est pas acceptée.";

export interface Commentaire {
  id: string; fichier: string; debut: number; fin: number;
  lignes: { marque: " " | "+" | "-"; texte: string }[];
  texte: string; cree: string; envoye: boolean; resolu: boolean; ligneChangee: boolean;
}

const Schema = z.array(z.object({
  id: z.string(), fichier: z.string(), debut: z.number(), fin: z.number(),
  lignes: z.array(z.object({ marque: z.enum([" ", "+", "-"]), texte: z.string() })),
  texte: z.string(), cree: z.string(), envoye: z.boolean(), resolu: z.boolean(), ligneChangee: z.boolean(),
}));

interface Affichee { marque: " " | "+" | "-"; texte: string; position: number; bloc: number; indice: number }

function affichees(blocs: Bloc[]): Affichee[] {
  return blocs.flatMap((b, bloc) => b.lignes.map((l, indice) => ({ marque: l.marque, texte: l.texte, position: positionNouvelle(b, indice), bloc, indice })));
}

function plusProche<T>(items: T[], pos: (t: T) => number, cible: number): T {
  return items.reduce((m, t) => (Math.abs(pos(t) - cible) < Math.abs(pos(m) - cible) ? t : m));
}

/** Réancrage pur : un commentaire n'est jamais supprimé, seulement déplacé ou marqué « ligne changée ». */
export function recoller(c: Commentaire, blocs: Bloc[]): Commentaire {
  const lignes = affichees(blocs);
  const n = c.lignes.length;
  const fenetres: Affichee[][] = [];
  if (n > 0) {
    for (let i = 0; i + n <= lignes.length; i++) {
      const f = lignes.slice(i, i + n);
      if (f.every((l, k) => l.bloc === f[0]!.bloc && l.marque === c.lignes[k]!.marque && l.texte === c.lignes[k]!.texte)) fenetres.push(f);
    }
  }
  if (fenetres.length > 0) {
    const f = plusProche(fenetres, (w) => w[0]!.position, c.debut);
    return { ...c, debut: f[0]!.position, fin: f[n - 1]!.position, ligneChangee: false };
  }
  const memeTexte = n > 0 ? lignes.filter((l) => l.texte === c.lignes[0]!.texte) : [];
  if (memeTexte.length > 0) {
    const l = plusProche(memeTexte, (x) => x.position, c.debut);
    return { ...c, debut: l.position, fin: l.position, ligneChangee: true };
  }
  if (lignes.length > 0) {
    const l = plusProche(lignes, (x) => x.position, c.debut);
    return { ...c, debut: l.position, fin: l.position, ligneChangee: true };
  }
  return { ...c, ligneChangee: true };
}

export class CommentairesRelecture {
  private ecritures: Promise<unknown> = Promise.resolve();

  constructor(private readonly fichier: string) {}

  private async lire(): Promise<Commentaire[]> {
    let brut: string;
    try { brut = await readFile(this.fichier, "utf8"); } catch { return []; }
    try { return Schema.parse(JSON.parse(brut)); } catch { return []; }
  }

  // Lecture-modification-écriture sérialisée : deux appels simultanés ne s'écrasent pas.
  private transformer<T>(f: (liste: Commentaire[]) => { liste: Commentaire[]; resultat: T }): Promise<T> {
    const tache = this.ecritures.then(async () => {
      const { liste, resultat } = f(await this.lire());
      await ecrireJsonPrive(this.fichier, liste);
      return resultat;
    });
    this.ecritures = tache.catch(() => undefined);
    return tache;
  }

  async liste(): Promise<Commentaire[]> {
    await this.ecritures;
    return this.lire();
  }

  ajouter(c: Pick<Commentaire, "fichier" | "debut" | "fin" | "lignes" | "texte">): Promise<Commentaire> {
    if (c.texte.trim() === "") return Promise.reject(new Error(REMARQUE_VIDE));
    return this.transformer((liste) => {
      const nouveau: Commentaire = {
        id: `c-${randomBytes(4).toString("hex")}`, fichier: c.fichier, debut: c.debut, fin: c.fin,
        lignes: c.lignes.map((l) => ({ marque: l.marque, texte: l.texte })), texte: c.texte,
        cree: new Date().toISOString(), envoye: false, resolu: false, ligneChangee: false,
      };
      return { liste: [...liste, nouveau], resultat: nouveau };
    });
  }

  modifier(id: string, texte: string): Promise<void> {
    if (texte.trim() === "") return Promise.reject(new Error(REMARQUE_VIDE));
    return this.transformer((liste) => ({ liste: liste.map((c) => (c.id === id ? { ...c, texte, envoye: false } : c)), resultat: undefined }));
  }

  resoudre(id: string, resolu: boolean): Promise<void> {
    return this.transformer((liste) => ({ liste: liste.map((c) => (c.id === id ? { ...c, resolu } : c)), resultat: undefined }));
  }

  supprimer(id: string): Promise<void> {
    return this.transformer((liste) => ({ liste: liste.filter((c) => c.id !== id), resultat: undefined }));
  }

  recollerFichier(chemin: string, diff: DiffFichier | null): Promise<Commentaire[]> {
    return this.transformer((liste) => {
      const suite = liste.map((c) => (c.fichier !== chemin ? c : diff ? recoller(c, diff.blocs) : { ...c, ligneChangee: true }));
      return { liste: suite, resultat: suite.filter((c) => c.fichier === chemin) };
    });
  }

  async aEnvoyer(): Promise<Commentaire[]> {
    return (await this.liste()).filter((c) => !c.resolu);
  }

  marquerEnvoyes(ids: string[]): Promise<void> {
    const ensemble = new Set(ids);
    return this.transformer((liste) => ({ liste: liste.map((c) => (ensemble.has(c.id) ? { ...c, envoye: true } : c)), resultat: undefined }));
  }

  apresRelu(): Promise<void> {
    return this.transformer((liste) => ({ liste: liste.filter((c) => !c.resolu), resultat: undefined }));
  }
}
