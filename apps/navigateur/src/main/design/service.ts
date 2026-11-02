import type { BrowserWindow, Rectangle, WebContents } from "electron";
import {
  destinationDe,
  etatLot,
  ID_PROJET,
  INDISPONIBLE_DESIGN,
  projetDemo,
  projetPourAdresse,
  projetPourFenetreApp,
  REMARQUE_VIDE,
  SANS_CLIENT,
  type ContexteDesign,
  type Element,
  type IdProjet,
  type Lot,
  type ProjetSuivi,
  type RegistreExternes,
  type Remarques,
} from "@webaios/noyau";
import type { ContexteCalque, ElementAffiche, EtatDesign, LotAffiche, ResultatExtension } from "../../commun/api";
import type { IdFenetre } from "../../commun/modele";
import { Calques } from "./calque";
import { armerViseur, capturerElement, desarmerViseur, lireSource, type CaptureViseur } from "./viseur";

export type CibleDesign = { type: "fenetre"; fenetreId: IdFenetre } | { type: "app"; dossier: string };

/** La bulle d'une remarque : 320×170, sous l'élément. */
export const TAILLE_BULLE = { largeur: 320, hauteur: 170 };
const ECART_BULLE = 6;

/** Clé d'une cible, aussi l'argument de son calque. */
export const cleCible = (c: CibleDesign): string => (c.type === "fenetre" ? `fenetre:${c.fenetreId}` : `app:${c.dossier}`);

/**
 * Place de la bulle dans la fenêtre : sous l'élément (rect CSS × zoom, décalé des bornes de la vue de la page), bornée
 * à la fenêtre.
 */
export function placeBulle(rect: CaptureViseur["rect"], zoom: number, bornes: Rectangle, fenetre: [number, number]): Rectangle {
  const borner = (v: number, max: number) => Math.round(Math.max(0, Math.min(v, max)));
  return {
    x: borner(bornes.x + rect.x * zoom, fenetre[0] - TAILLE_BULLE.largeur),
    y: borner(bornes.y + (rect.y + rect.hauteur) * zoom + ECART_BULLE, fenetre[1] - TAILLE_BULLE.hauteur),
    width: TAILLE_BULLE.largeur,
    height: TAILLE_BULLE.hauteur,
  };
}

function sourceTexte(s: ContexteDesign["source"]): string | null {
  if (!s) return null;
  return s.ligne !== undefined ? `${s.fichier}:${s.ligne}` : s.fichier;
}

export function elementAffiche(e: Element): ElementAffiche {
  const base = { id: e.id, type: e.type, texte: e.texte, traite: e.traite ?? null };
  return e.type === "design"
    ? { ...base, etiquette: e.contexte.etiquette, source: sourceTexte(e.contexte.source) }
    : { ...base, etiquette: `${e.contexte.fichier}:${e.contexte.debut}-${e.contexte.fin}`, source: e.contexte.fichier };
}

export function lotAffiche(l: Lot): LotAffiche {
  return { id: l.id, cree: l.cree, etat: etatLot(l), destination: l.destination, elements: l.elements.map(elementAffiche) };
}

interface VueCible {
  wc: WebContents;
  bornes: Rectangle;
  fenetre: BrowserWindow;
  url: string;
}

/** Un mode design en cours sur une cible. */
interface Session {
  cible: CibleDesign;
  cle: string;
  projet: ProjetSuivi;
  wc: WebContents;
  fenetre: BrowserWindow;
  /** Chaque armement a son numéro : le résultat d'un armement dépassé est ignoré. */
  generation: number;
  /** Une navigation sans nouveau document a eu lieu pendant l'armement : le viseur est réarmé, le mode reste. */
  memeDocument: boolean;
  /** Capture en attente du texte de l'utilisateur (bulle ouverte). */
  attente: { contexte: ContexteDesign; capture: Buffer | null } | null;
  nettoyer: () => void;
}

export interface OptionsServiceDesign {
  remarques: Remarques;
  registre: () => RegistreExternes | null;
  /** Les applis en marche (leurs ports). */
  applis: () => Promise<{ dossier: string; nom: string; port: number }[]>;
  plages: [number, number][];
  /** La vue de l'onglet affiché dans la fenêtre principale `f`, ses bornes dans la fenêtre, et son adresse. */
  vueOnglet(f: IdFenetre): VueCible | null;
  fenetreApp(dossier: string): BrowserWindow | null;
  /** Un mode, un panier ou un projet a changé : les interfaces relisent. */
  diffuser(): void;
  /** Après l'écriture du lot (tâche 9 : pré-remplir la session de l'agent). */
  envoyer(p: ProjetSuivi, lot: Lot): Promise<void>;
  /** « Relire ce projet » (tâche 11). */
  relire?(p: ProjetSuivi, c: CibleDesign): void;
}

/**
 * Le mode design de chaque cible (onglet actif d'une fenêtre principale, fenêtre d'appli) : le viseur armé tant que le
 * mode est actif ; à chaque capture, la bulle du calque ; la remarque va au panier du projet suivi, puis le viseur est
 * réarmé. Un second basculement, Échap dans la page, une navigation vers un autre document, un autre onglet ou la
 * fermeture arrêtent le mode (le panier reste).
 */
export class ServiceDesign {
  private readonly sessions = new Map<string, Session>();
  readonly calques = new Calques();

  constructor(private readonly o: OptionsServiceDesign) {}

  private vue(c: CibleDesign): VueCible | null {
    if (c.type === "fenetre") return this.o.vueOnglet(c.fenetreId);
    const f = this.o.fenetreApp(c.dossier);
    if (!f || f.isDestroyed() || f.webContents.isDestroyed()) return null;
    const [width = 0, height = 0] = f.getContentSize();
    return { wc: f.webContents, bornes: { x: 0, y: 0, width, height }, fenetre: f, url: f.webContents.getURL() };
  }

  private async projetDe(c: CibleDesign, url: string): Promise<ProjetSuivi | null> {
    const applis = await this.o.applis();
    if (c.type === "app") return projetPourFenetreApp(c.dossier, applis.find((a) => a.dossier === c.dossier)?.nom ?? c.dossier);
    return projetPourAdresse(url, { appsLancees: applis, plages: this.o.plages, externes: this.o.registre()?.projets() ?? [] });
  }

  /** Le projet suivi d'un id (panier, envoi) ; null s'il n'est plus connu (projet externe oublié). */
  async projetSuivi(p: IdProjet): Promise<ProjetSuivi | null> {
    if (!ID_PROJET.test(p)) return null;
    if (p.startsWith("app-")) {
      const dossier = p.slice(4);
      return projetPourFenetreApp(dossier, (await this.o.applis()).find((a) => a.dossier === dossier)?.nom ?? dossier);
    }
    if (p.startsWith("demo-")) return { type: "demo", projet: projetDemo(Number(p.slice(5))), port: Number(p.slice(5)) };
    const e = this.o.registre()?.projets().find((x) => `ext-${x.id}` === p);
    return e ? { type: "externe", projet: p, dossier: e.dossier, nom: e.nom, client: e.client } : null;
  }

  private destination(p: ProjetSuivi): { destination: string | null; sansDestination: string | null } {
    const d = destinationDe(p, this.o.registre()?.clients() ?? []);
    return "libelle" in d ? { destination: d.libelle, sansDestination: null } : { destination: null, sansDestination: d.indisponible };
  }

  private nom(p: ProjetSuivi): string {
    return p.type === "demo" ? `localhost:${p.port}` : p.nom;
  }

  /** Le projet suivi de la cible, s'il y en a un (le mode y est disponible). */
  async projetCourant(c: CibleDesign): Promise<ProjetSuivi | null> {
    const v = this.vue(c);
    return v ? this.projetDe(c, v.url) : null;
  }

  async etat(c: CibleDesign): Promise<EtatDesign> {
    const s = this.sessions.get(cleCible(c));
    const projet = s?.projet ?? (await this.projetCourant(c));
    if (!projet) return { actif: false, projet: null, indisponible: INDISPONIBLE_DESIGN, destination: null, sansDestination: null, panier: 0, nom: "" };
    const panier = (await this.o.remarques.panier(projet.projet)).length;
    return { actif: !!s, projet, indisponible: null, ...this.destination(projet), panier, nom: this.nom(projet) };
  }

  async basculer(c: CibleDesign): Promise<void> {
    const cle = cleCible(c);
    if (this.sessions.has(cle)) return this.arreter(c);
    const v = this.vue(c);
    if (!v) return;
    const projet = await this.projetDe(c, v.url);
    // Indisponible : rien n'est injecté dans la page.
    if (!projet || this.sessions.has(cle) || v.wc.isDestroyed()) return;
    const surNavigation = (d: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (!d.isMainFrame) return;
      if (d.isSameDocument) s.memeDocument = true;
      else void this.arreter(c);
    };
    const surFin = () => void this.arreter(c);
    v.wc.on("did-start-navigation", surNavigation);
    v.wc.on("destroyed", surFin);
    v.wc.on("render-process-gone", surFin);
    const s: Session = {
      cible: c, cle, projet, wc: v.wc, fenetre: v.fenetre, generation: 0, memeDocument: false, attente: null,
      nettoyer: () => {
        if (v.wc.isDestroyed()) return;
        v.wc.off("did-start-navigation", surNavigation);
        v.wc.off("destroyed", surFin);
        v.wc.off("render-process-gone", surFin);
      },
    };
    this.sessions.set(cle, s);
    this.o.diffuser();
    // Le clavier va à la page (il était au bouton, au menu ou à la pastille) : Échap y arrête le mode.
    this.rendreClavier(s);
    void this.armer(s);
  }

  /** Rend le clavier à la page de la session (et sa fenêtre d'appli au premier plan, hors tests invisibles). */
  private rendreClavier(s: Session): void {
    if (s.cible.type === "app" && process.env.WEBAIOS_INVISIBLE !== "1" && !s.fenetre.isDestroyed()) s.fenetre.focus();
    if (!s.wc.isDestroyed()) s.wc.focus();
  }

  private actuelle(s: Session, generation: number): boolean {
    return this.sessions.get(s.cle) === s && s.generation === generation;
  }

  private async armer(s: Session): Promise<void> {
    const g = ++s.generation;
    s.memeDocument = false;
    const capture = await armerViseur(s.wc);
    if (!this.actuelle(s, g)) return;
    if (!capture) {
      // Navigation dans le même document : le viseur s'est arrêté, le mode continue.
      if (s.memeDocument) return this.armer(s);
      // Échap dans la page, page partie : le mode s'arrête.
      return this.arreter(s.cible);
    }
    const source = await lireSource(s.wc, capture.selecteur);
    const png = await capturerElement(s.wc, capture.rect, capture.vue);
    if (!this.actuelle(s, g)) return;
    const { rect, ...contexte } = capture;
    s.attente = { contexte: { ...contexte, source }, capture: png };
    const v = this.vue(s.cible);
    if (!v || v.wc !== s.wc || s.fenetre.isDestroyed()) return this.arreter(s.cible);
    const [l = 0, h = 0] = s.fenetre.getContentSize();
    const place = placeBulle(rect, s.wc.isDestroyed() ? 1 : s.wc.getZoomFactor(), v.bornes, [l, h]);
    this.calques.montrerBulle(s.cle, s.fenetre, place, {
      mode: "bulle",
      projet: s.projet.projet,
      etiquette: contexte.etiquette,
      source: sourceTexte(source),
      ...this.destination(s.projet),
    });
  }

  /** Arrête le mode : bulle fermée, viseur désarmé ; le panier reste. */
  async arreter(c: CibleDesign): Promise<void> {
    const s = this.sessions.get(cleCible(c));
    if (!s) return;
    this.sessions.delete(s.cle);
    s.generation++;
    s.attente = null;
    s.nettoyer();
    this.calques.fermerBulle(s.cle);
    this.o.diffuser();
    if (!s.wc.isDestroyed()) await desarmerViseur(s.wc);
  }

  /** Depuis la bulle : la capture en attente et le texte vont au panier, puis le viseur est réarmé. */
  async ajouter(c: CibleDesign, texte: string): Promise<ResultatExtension> {
    const s = this.sessions.get(cleCible(c));
    const attente = s?.attente;
    if (!s || !attente) return { ok: false, erreur: "Aucun élément visé." };
    if (texte.trim() === "") return { ok: false, erreur: REMARQUE_VIDE };
    try {
      await this.o.remarques.ajouterAuPanier(s.projet.projet, { texte, contexte: attente.contexte, capture: attente.capture });
    } catch (e) {
      return { ok: false, erreur: e instanceof Error ? e.message : String(e) };
    }
    if (this.sessions.get(s.cle) !== s || s.attente !== attente) return { ok: true };
    s.attente = null;
    this.calques.fermerBulle(s.cle);
    this.rendreClavier(s);
    void this.armer(s);
    return { ok: true };
  }

  /** « Annuler » (Échap) de la bulle : rien n'est ajouté, le viseur est réarmé. Sans bulle : ferme le panier du calque. */
  annuler(c: CibleDesign): void {
    const s = this.sessions.get(cleCible(c));
    if (!s?.attente) return this.calques.fermerPanier(cleCible(c));
    s.attente = null;
    this.calques.fermerBulle(s.cle);
    this.rendreClavier(s);
    void this.armer(s);
  }

  /** Fenêtres principales : un mode dont l'onglet n'est plus celui affiché (autre onglet, onglet fermé) s'arrête. */
  verifierOnglets(): void {
    for (const s of [...this.sessions.values()]) {
      if (s.cible.type !== "fenetre") continue;
      const v = this.o.vueOnglet(s.cible.fenetreId);
      if (!v || v.wc !== s.wc) void this.arreter(s.cible);
    }
  }

  /** La fenêtre de la cible est fermée : le mode s'arrête et le calque est fermé. */
  oublier(c: CibleDesign): void {
    void this.arreter(c);
    this.calques.oublier(cleCible(c));
  }

  /** « Panier » d'une fenêtre d'appli : le calque de la fenêtre montre le panier de l'appli. */
  async ouvrirPanier(c: CibleDesign): Promise<void> {
    const v = this.vue(c);
    const projet = await this.projetCourant(c);
    if (!v || !projet) return;
    this.calques.montrerPanier(cleCible(c), v.fenetre, { mode: "panier", projet: projet.projet, etiquette: "", source: null, ...this.destination(projet) });
  }

  async relire(c: CibleDesign): Promise<void> {
    const projet = await this.projetCourant(c);
    if (projet && projet.type !== "demo") this.o.relire?.(projet, c);
  }

  contexteCalque(c: CibleDesign): ContexteCalque | null {
    return this.calques.contexte(cleCible(c));
  }

  /** La cible d'un calque, d'après son expéditeur. */
  cibleDeCalque(sender: WebContents): CibleDesign | undefined {
    const cle = this.calques.cibleDe(sender);
    if (!cle) return undefined;
    return cle.startsWith("fenetre:") ? { type: "fenetre", fenetreId: cle.slice(8) } : { type: "app", dossier: cle.slice(4) };
  }

  async panier(p: IdProjet): Promise<ElementAffiche[]> {
    return (await this.o.remarques.panier(p)).map(elementAffiche);
  }

  async lots(p: IdProjet): Promise<LotAffiche[]> {
    return (await this.o.remarques.lots(p)).map(lotAffiche);
  }

  retirer(p: IdProjet, id: string): Promise<void> {
    return this.o.remarques.retirerDuPanier(p, id);
  }

  traite(p: IdProjet, lot: string): Promise<void> {
    return this.o.remarques.marquerLotTraite(p, lot);
  }

  /** Le panier devient un lot pour l'agent (app, démo) ou le Claude Code branché (externe). */
  async envoyer(p: IdProjet): Promise<ResultatExtension> {
    const projet = await this.projetSuivi(p);
    if (!projet) return { ok: false, erreur: SANS_CLIENT };
    let destination: { destination: "agent" | "mcp"; client?: string } = { destination: "agent" };
    if (projet.type === "externe") {
      const d = destinationDe(projet, this.o.registre()?.clients() ?? []);
      if ("indisponible" in d || projet.client === null) return { ok: false, erreur: SANS_CLIENT };
      destination = { destination: "mcp", client: projet.client };
    }
    try {
      const lot = await this.o.remarques.envoyerPanier(p, destination);
      await this.o.envoyer(projet, lot);
      return { ok: true };
    } catch (e) {
      return { ok: false, erreur: e instanceof Error ? e.message : String(e) };
    }
  }
}
