import { SvelteMap } from "svelte/reactivity";
import type { ApiWebaios } from "../../commun/api";
import { MODELE_CODE } from "./ajout";

export type DepotCode = Pick<ApiWebaios["workflow"], "lireCode" | "enregistrerCode">;

/** `base` : le texte du disque quand le brouillon a commencé (null : fichier absent), pour voir un changement de l'agent. */
type BrouillonCode = { texte: string; base: string | null };

/**
 * Les codes non enregistrés de cette fenêtre, par `<widget>/<fichier>` : ils survivent au changement de bloc et
 * d'onglet ; seul « Enregistrer le code » les écrit.
 */
const brouillons = new SvelteMap<string, BrouillonCode>();
const cleCode = (widget: string, nom: string) => `${widget}/${nom}`;

/** Fichiers dont le code n'est pas enregistré : ceux du widget (noms), ou tous (`<widget>/<fichier>`). */
export function codesNonEnregistres(widget?: string): string[] {
  const cles = [...brouillons.keys()];
  if (widget === undefined) return cles;
  return cles.filter((c) => c.startsWith(`${widget}/`)).map((c) => c.slice(widget.length + 1));
}

/**
 * Abandonne les brouillons des widgets dont plus aucun onglet du constructeur n'est ouvert dans la fenêtre (onglet
 * fermé par l'agent, espace fermé…) : la fenêtre ne retient jamais sa fermeture pour un code qu'on ne voit plus.
 */
export function garderCodesDe(ouverts: Iterable<string>): void {
  const w = new Set(ouverts);
  for (const c of [...brouillons.keys()]) if (!w.has(c.slice(0, c.indexOf("/")))) brouillons.delete(c);
}

/** Abandonne les brouillons d'un widget (onglet fermé malgré tout), ou tous. */
export function oublierCodes(widget?: string): void {
  for (const c of [...brouillons.keys()]) if (widget === undefined || c.startsWith(`${widget}/`)) brouillons.delete(c);
}

/** Le fichier `.mjs` d'un bloc `code` tel que l'éditeur le montre : texte du disque, ou brouillon de l'utilisateur. */
export class FichierCode {
  /** Texte sur le disque ; null : absent ; undefined : pas encore lu. */
  disque = $state<string | null | undefined>(undefined);
  erreur = $state<string | null>(null);
  /** Le fichier a changé sur le disque depuis le début du brouillon : bandeau [Recharger] [Garder le mien]. */
  changeSurDisque = $state(false);
  enregistrement = $state(false);
  private lecture = 0;

  constructor(
    readonly widget: string,
    readonly nom: string,
    private readonly depot: DepotCode,
  ) {}

  private get cle(): string {
    return cleCode(this.widget, this.nom);
  }

  get texte(): string {
    return brouillons.get(this.cle)?.texte ?? this.disque ?? MODELE_CODE;
  }

  /** Brouillon tapé par l'utilisateur (changer de bloc ou fermer demande confirmation). */
  get aBrouillon(): boolean {
    return brouillons.has(this.cle);
  }

  /** Un brouillon, ou un fichier absent (le modèle affiché n'existe pas encore). */
  get nonEnregistre(): boolean {
    return this.aBrouillon || this.disque === null;
  }

  /** (Re)lit le fichier ; un brouillon n'est jamais remplacé, seulement signalé si le disque a changé sous lui. */
  async lire(): Promise<void> {
    const n = ++this.lecture;
    const l = await this.depot.lireCode(this.widget, this.nom);
    if (n !== this.lecture) return;
    if ("erreur" in l) {
      this.erreur = l.erreur;
      return;
    }
    if (this.erreur !== null && !this.enregistrement) this.erreur = null;
    const t = "texte" in l ? l.texte : null;
    this.disque = t;
    const b = brouillons.get(this.cle);
    if (!b) {
      this.changeSurDisque = false;
      return;
    }
    if (t !== null && b.texte === t) {
      // Le disque a rejoint le brouillon (l'agent a écrit la même chose) : plus rien à enregistrer.
      brouillons.delete(this.cle);
      this.changeSurDisque = false;
      return;
    }
    this.changeSurDisque = t !== b.base;
  }

  saisir(texte: string): void {
    if (this.disque === undefined) return;
    const b = brouillons.get(this.cle);
    if (texte === (this.disque ?? MODELE_CODE)) {
      brouillons.delete(this.cle);
      this.changeSurDisque = false;
    } else brouillons.set(this.cle, { texte, base: b ? b.base : this.disque });
  }

  /** « Enregistrer le code » et ⌘S : seulement quand il y a quelque chose à écrire. */
  async enregistrer(): Promise<void> {
    if (!this.nonEnregistre || this.enregistrement || this.disque === undefined) return;
    const texte = this.texte;
    this.enregistrement = true;
    try {
      const r = await this.depot.enregistrerCode(this.widget, this.nom, texte);
      if (!r.ok) {
        this.erreur = r.erreur;
        return;
      }
      this.erreur = null;
      this.disque = texte;
      this.changeSurDisque = false;
      const b = brouillons.get(this.cle);
      // Une frappe pendant l'écriture reste un brouillon, sur la base de ce qui vient d'être écrit.
      if (!b || b.texte === texte) brouillons.delete(this.cle);
      else brouillons.set(this.cle, { texte: b.texte, base: texte });
    } catch (e) {
      this.erreur = (e as Error).message || "Enregistrement impossible";
    } finally {
      this.enregistrement = false;
    }
  }

  /** Bandeau : abandonner le brouillon pour le fichier du disque. */
  recharger(): void {
    brouillons.delete(this.cle);
    this.changeSurDisque = false;
  }

  /** Bandeau : garder le brouillon ; il remplacera la version du disque à l'enregistrement. */
  garderLeMien(): void {
    const b = brouillons.get(this.cle);
    if (b && this.disque !== undefined) brouillons.set(this.cle, { texte: b.texte, base: this.disque });
    this.changeSurDisque = false;
  }
}

/** Changer de bloc avec le code de `nom` non enregistré : L'utilisateur confirme (le brouillon reste gardé). */
export function confirmerChangementDeBloc(widget: string, nom: string): boolean {
  if (!brouillons.has(cleCode(widget, nom))) return true;
  return confirm(`Le code de ${nom} n'est pas enregistré. Changer de bloc quand même ? Il reste gardé dans cette fenêtre.`);
}

/** Fermer le constructeur du widget avec du code non enregistré : L'utilisateur confirme, et le brouillon est abandonné. */
export function confirmerFermeture(widget: string): boolean {
  const noms = codesNonEnregistres(widget);
  if (noms.length === 0) return true;
  if (!confirm(`Le code de ${noms.join(", ")} n'est pas enregistré. Fermer quand même ? Il sera perdu.`)) return false;
  oublierCodes(widget);
  return true;
}

let garde = false;
/**
 * Une fois par fenêtre : la fermer avec du code non enregistré passe par « beforeunload » (le process principal demande
 * alors confirmation).
 */
export function garderAvantFermeture(): void {
  if (garde) return;
  garde = true;
  window.addEventListener("beforeunload", (e) => {
    if (brouillons.size === 0) return;
    e.preventDefault();
    e.returnValue = "";
  });
}
