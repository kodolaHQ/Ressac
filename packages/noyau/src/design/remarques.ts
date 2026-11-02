import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { REMARQUE_VIDE } from "../relecture/commentaires.js";
import { ecrireJsonPrive } from "./ecriture-atomique.js";
import { ID_PROJET, dossierRemarques, type DossiersDesign, type IdProjet } from "./projets.js";

export const PANIER_VIDE = "Le panier est vide.";
export const HTML_MAX = 4096;
export const TRONQUE = "… [tronqué]";
export const JOURS_PURGE = 30;

export interface ContexteDesign {
  selecteur: string; etiquette: string; html: string;
  voisinage: { parent: string; freres: string[] };
  styles: Record<string, string>;
  source: { fichier: string; ligne?: number; colonne?: number } | null;
  adresse: string; vue: { largeur: number; hauteur: number };
}
export interface ContexteRelecture { fichier: string; debut: number; fin: number; lignes: { marque: " " | "+" | "-"; texte: string }[] }
export type Element =
  | { id: string; type: "design"; texte: string; contexte: ContexteDesign; capture: string | null; traite?: { quand: string; note?: string } }
  | { id: string; type: "relecture"; texte: string; contexte: ContexteRelecture; traite?: { quand: string; note?: string } };
export interface Lot { id: string; projet: IdProjet; cree: string; destination: "agent" | "mcp"; client?: string; lu?: string; elements: Element[] }
export type EtatLot = "en-attente" | "lu" | "traite";
type Destination = { destination: "agent" | "mcp"; client?: string };

const ID_LOT = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;
const ID_ELEMENT = /^e-[0-9a-f]{8}$/;
const JOUR_MS = 86_400_000;

export function etatLot(l: Lot): EtatLot {
  if (l.elements.length > 0 && l.elements.every((e) => e.traite)) return "traite";
  return l.lu ? "lu" : "en-attente";
}

export function tronquerHtml(html: string): string {
  return html.length > HTML_MAX ? html.slice(0, HTML_MAX) + TRONQUE : html;
}

/** Côté espace (lu par l'agent du conteneur) : atomique, modes par défaut. Côté privé : 0o700/0o600. */
async function ecrireAtomique(fichier: string, contenu: string | Buffer, prive: boolean): Promise<void> {
  const dossier = dirname(fichier);
  if (prive) {
    await mkdir(dossier, { recursive: true, mode: 0o700 });
    await chmod(dossier, 0o700);
  } else await mkdir(dossier, { recursive: true });
  const temporaire = join(dossier, `${basename(fichier)}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temporaire, contenu, prive ? { mode: 0o600 } : {});
  if (prive) await chmod(temporaire, 0o600);
  await rename(temporaire, fichier);
}

/** Le JSON peut venir du conteneur : ids d'éléments valides, capture seulement `<id>.png`. */
function assainir(v: unknown): Element[] {
  if (!Array.isArray(v)) return [];
  const sortie: Element[] = [];
  for (const e of v as Element[]) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !ID_ELEMENT.test(e.id)) continue;
    sortie.push(e.type === "design" ? { ...e, capture: e.capture === `${e.id}.png` ? e.capture : null } : e);
  }
  return sortie;
}

async function lireJson<T>(fichier: string): Promise<T | null> {
  try { return JSON.parse(await readFile(fichier, "utf8")) as T; } catch { return null; }
}

export class Remarques {
  private readonly dossiers: DossiersDesign;
  private readonly maintenant: () => Date;
  private readonly files = new Map<IdProjet, Promise<unknown>>();
  private readonly attentes = new Map<IdProjet, Set<() => void>>();
  private readonly ecouteurs = new Set<(p: IdProjet) => void>();

  constructor(o: { dossiers: DossiersDesign; maintenant?: () => Date }) {
    this.dossiers = o.dossiers;
    this.maintenant = o.maintenant ?? (() => new Date());
  }

  /** Visible pour les tests : nombre d'attentes encore enregistrées. */
  nombreAttentes(): number {
    let n = 0;
    for (const s of this.attentes.values()) n += s.size;
    return n;
  }

  private dossier(p: IdProjet): string {
    if (!ID_PROJET.test(p)) throw new Error(`Projet invalide : ${p}`);
    return dossierRemarques(this.dossiers, p);
  }
  private estPrive(p: IdProjet): boolean { return p.startsWith("ext-"); }

  private serialiser<T>(p: IdProjet, f: () => Promise<T>): Promise<T> {
    const precedent = this.files.get(p) ?? Promise.resolve();
    const suite = precedent.then(f, f);
    const garde = suite.catch(() => undefined);
    this.files.set(p, garde);
    void garde.then(() => { if (this.files.get(p) === garde) this.files.delete(p); });
    return suite;
  }

  private notifier(p: IdProjet): void { for (const f of [...this.ecouteurs]) f(p); }

  private async lirePanier(p: IdProjet): Promise<Element[]> {
    const v = await lireJson<Element[]>(join(this.dossier(p), "panier.json"));
    return assainir(v);
  }
  private ecrirePanier(p: IdProjet, panier: Element[]): Promise<void> {
    const f = join(this.dossier(p), "panier.json");
    return this.estPrive(p) ? ecrireJsonPrive(f, panier) : ecrireAtomique(f, JSON.stringify(panier, null, 2), false);
  }
  private ecrireLot(l: Lot): Promise<void> {
    const f = join(this.dossierLot(l.projet, l.id), "lot.json");
    return this.estPrive(l.projet) ? ecrireJsonPrive(f, l) : ecrireAtomique(f, JSON.stringify(l, null, 2), false);
  }
  private async lireLots(p: IdProjet): Promise<Lot[]> {
    let noms: string[];
    try { noms = await readdir(this.dossier(p)); } catch { return []; }
    const lots: Lot[] = [];
    for (const n of noms.filter((x) => ID_LOT.test(x)).sort().reverse()) {
      const l = await lireJson<Lot>(join(this.dossier(p), n, "lot.json"));
      if (l && Array.isArray(l.elements)) lots.push({ ...l, id: n, projet: p, elements: assainir(l.elements) });
    }
    return lots;
  }

  dossierLot(p: IdProjet, lot: string): string {
    if (!ID_LOT.test(lot)) throw new Error(`Lot invalide : ${lot}`);
    return join(this.dossier(p), lot);
  }

  async panier(p: IdProjet): Promise<Element[]> {
    this.dossier(p);
    return this.serialiser(p, () => this.lirePanier(p));
  }

  async ajouterAuPanier(p: IdProjet, e: { texte: string; contexte: ContexteDesign; capture: Buffer | null }): Promise<Element> {
    this.dossier(p);
    if (e.texte.trim() === "") return Promise.reject(new Error(REMARQUE_VIDE));
    return this.serialiser(p, async () => {
      const id = `e-${randomBytes(4).toString("hex")}`;
      if (e.capture) await ecrireAtomique(join(this.dossier(p), `${id}.png`), e.capture, this.estPrive(p));
      const element: Element = {
        id, type: "design", texte: e.texte, contexte: { ...e.contexte, html: tronquerHtml(e.contexte.html) },
        capture: e.capture ? `${id}.png` : null,
      };
      const panier = await this.lirePanier(p);
      panier.push(element);
      await this.ecrirePanier(p, panier);
      this.notifier(p);
      return element;
    });
  }

  async retirerDuPanier(p: IdProjet, id: string): Promise<void> {
    this.dossier(p);
    return this.serialiser(p, async () => {
      const panier = await this.lirePanier(p);
      const reste = panier.filter((e) => e.id !== id);
      if (reste.length === panier.length) return;
      await this.ecrirePanier(p, reste);
      if (ID_ELEMENT.test(id)) await rm(join(this.dossier(p), `${id}.png`), { force: true });
      this.notifier(p);
    });
  }

  private creerLot(p: IdProjet, elements: Element[], d: Destination): Lot {
    const t = this.maintenant();
    const horodatage = t.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const lot: Lot = { id: `${horodatage}-${randomBytes(2).toString("hex")}`, projet: p, cree: t.toISOString(), destination: d.destination, elements };
    if (d.client !== undefined) lot.client = d.client;
    return lot;
  }

  private reveiller(p: IdProjet): void {
    const s = this.attentes.get(p);
    if (!s) return;
    this.attentes.delete(p);
    for (const f of [...s]) f();
  }

  async envoyerPanier(p: IdProjet, d: Destination): Promise<Lot> {
    this.dossier(p);
    return this.serialiser(p, async () => {
      const panier = await this.lirePanier(p);
      if (panier.length === 0) throw new Error(PANIER_VIDE);
      const lot = this.creerLot(p, panier, d);
      const cible = this.dossierLot(p, lot.id);
      await mkdir(cible, { recursive: true, ...(this.estPrive(p) ? { mode: 0o700 } : {}) });
      for (const e of panier) {
        if (e.type === "design" && e.capture) await rename(join(this.dossier(p), e.capture), join(cible, e.capture)).catch(() => undefined);
      }
      await this.ecrireLot(lot);
      await this.ecrirePanier(p, []);
      this.notifier(p);
      if (d.destination === "mcp") this.reveiller(p);
      return lot;
    });
  }

  async envoyerRelecture(p: IdProjet, elements: { texte: string; contexte: ContexteRelecture }[], d: Destination): Promise<Lot> {
    this.dossier(p);
    if (elements.some((e) => e.texte.trim() === "")) return Promise.reject(new Error(REMARQUE_VIDE));
    if (elements.length === 0) return Promise.reject(new Error(PANIER_VIDE));
    return this.serialiser(p, async () => {
      const lot = this.creerLot(p, elements.map((e) => ({
        id: `e-${randomBytes(4).toString("hex")}`, type: "relecture" as const, texte: e.texte, contexte: e.contexte,
      })), d);
      await this.ecrireLot(lot);
      this.notifier(p);
      if (d.destination === "mcp") this.reveiller(p);
      return lot;
    });
  }

  async lots(p: IdProjet): Promise<Lot[]> {
    this.dossier(p);
    return this.serialiser(p, () => this.lireLots(p));
  }

  async aLire(p: IdProjet): Promise<Lot[]> {
    this.dossier(p);
    return this.serialiser(p, async () => {
      const rendus: Lot[] = [];
      let change = false;
      for (const l of await this.lireLots(p)) {
        if (l.destination !== "mcp" || etatLot(l) === "traite") continue;
        if (!l.lu) {
          l.lu = this.maintenant().toISOString();
          await this.ecrireLot(l);
          change = true;
        }
        rendus.push({ ...l, elements: l.elements.filter((e) => !e.traite) });
      }
      if (change) this.notifier(p);
      return rendus;
    });
  }

  async attendre(p: IdProjet, delaiMs: number, signal?: AbortSignal): Promise<void> {
    this.dossier(p);
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((fini) => {
      let minuteur: ReturnType<typeof setTimeout> | undefined;
      const fin = (): void => {
        if (minuteur !== undefined) clearTimeout(minuteur);
        signal?.removeEventListener("abort", fin);
        const s = this.attentes.get(p);
        if (s) { s.delete(fin); if (s.size === 0) this.attentes.delete(p); }
        fini();
      };
      let s = this.attentes.get(p);
      if (!s) { s = new Set(); this.attentes.set(p, s); }
      s.add(fin);
      minuteur = setTimeout(fin, Math.max(0, delaiMs));
      signal?.addEventListener("abort", fin, { once: true });
    });
  }

  async marquerTraites(p: IdProjet, ids: string[], note?: string): Promise<{ marques: string[]; inconnus: string[] }> {
    this.dossier(p);
    return this.serialiser(p, async () => {
      const quand = this.maintenant().toISOString();
      const connus = new Set<string>();
      const marques: string[] = [];
      for (const l of await this.lireLots(p)) {
        let modifie = false;
        for (const e of l.elements) {
          if (!ids.includes(e.id)) continue;
          connus.add(e.id);
          if (e.traite) continue;
          e.traite = note !== undefined && note !== "" ? { quand, note } : { quand };
          modifie = true;
        }
        if (modifie) await this.ecrireLot(l);
      }
      for (const id of ids) if (connus.has(id) && !marques.includes(id)) marques.push(id);
      const inconnus = ids.filter((id) => !connus.has(id));
      if (marques.length > 0) this.notifier(p);
      return { marques, inconnus };
    });
  }

  async marquerLotTraite(p: IdProjet, lot: string): Promise<void> {
    this.dossierLot(p, lot);
    return this.serialiser(p, async () => {
      const l = (await this.lireLots(p)).find((x) => x.id === lot);
      if (!l) return;
      const quand = this.maintenant().toISOString();
      for (const e of l.elements) if (!e.traite) e.traite = { quand };
      await this.ecrireLot(l);
      this.notifier(p);
    });
  }

  async purger(): Promise<number> {
    const limite = this.maintenant().getTime() - JOURS_PURGE * JOUR_MS;
    let n = 0;
    const racines = [this.dossiers.remarquesEspace, join(this.dossiers.prive, "remarques")];
    for (const racine of racines) {
      let projets: string[];
      try { projets = await readdir(racine); } catch { continue; }
      for (const p of projets.filter((x) => ID_PROJET.test(x))) {
        n += await this.serialiser(p, async () => {
          let supprimes = 0;
          for (const l of await this.lireLots(p)) {
            if (etatLot(l) !== "traite") continue;
            const dernier = Math.max(...l.elements.map((e) => Date.parse(e.traite?.quand ?? "") || 0));
            if (dernier >= limite) continue;
            await rm(this.dossierLot(p, l.id), { recursive: true, force: true });
            supprimes++;
          }
          return supprimes;
        });
      }
    }
    return n;
  }

  async oublier(p: IdProjet): Promise<void> {
    this.dossier(p);
    return this.serialiser(p, async () => {
      await rm(this.dossier(p), { recursive: true, force: true });
      this.notifier(p);
    });
  }

  surChange(f: (p: IdProjet) => void): () => void {
    this.ecouteurs.add(f);
    return () => { this.ecouteurs.delete(f); };
  }
}
