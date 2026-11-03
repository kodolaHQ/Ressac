import type { BrowserWindow, Input, Rectangle, WebContents } from "electron";
import {
  AVERTISSEMENT_CAPTURE_SITE,
  destinationDe,
  etatLot,
  ID_PROJET,
  INDISPONIBLE_DESIGN,
  INDISPONIBLE_DESIGN_SITE,
  projetDemo,
  projetPourAdresse,
  projetPourFenetreApp,
  projetPourSite,
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
import type { VueDesignSite } from "../sites/fenetres";
import { Calques } from "./calque";
import { armerViseur, capturerElement, desarmerViseur, lireSource, type CaptureViseur } from "./viseur";

export type CibleDesign = { type: "fenetre"; fenetreId: IdFenetre } | { type: "app"; dossier: string } | { type: "site"; id: string };

/** La bulle d'une remarque : 320×170, sous l'élément. */
export const TAILLE_BULLE = { largeur: 320, hauteur: 170 };
/** La bulle dans une appli de site : 20 px de plus pour la ligne d'avertissement. */
export const TAILLE_BULLE_SITE = { largeur: 320, hauteur: 190 };
const ECART_BULLE = 6;
/** Le message d'indisponibilité de la fenêtre principale : 360×56, à 12 px du haut et de la droite de la vue de l'onglet. */
const LARGEUR_MESSAGE = 360;
const HAUTEUR_MESSAGE = 56;
const MARGE_MESSAGE = 12;

/** Clé d'une cible, aussi l'argument de son calque. */
export const cleCible = (c: CibleDesign): string =>
  c.type === "fenetre" ? `fenetre:${c.fenetreId}` : c.type === "app" ? `app:${c.dossier}` : `site:${c.id}`;

/**
 * Place de la bulle dans la fenêtre : sous l'élément (rect CSS × zoom, décalé des bornes de la vue de la page), bornée
 * à la fenêtre, et jamais au-dessus de `hautMin` (le bas de la barre d'une appli de site).
 */
export function placeBulle(
  rect: CaptureViseur["rect"],
  zoom: number,
  bornes: Rectangle,
  fenetre: [number, number],
  o: { hautMin?: number; hauteur?: number } = {},
): Rectangle {
  const hauteur = o.hauteur ?? TAILLE_BULLE.hauteur;
  const borner = (v: number, max: number) => Math.round(Math.max(0, Math.min(v, max)));
  return {
    x: borner(bornes.x + rect.x * zoom, fenetre[0] - TAILLE_BULLE.largeur),
    y: Math.max(o.hautMin ?? 0, borner(bornes.y + (rect.y + rect.hauteur) * zoom + ECART_BULLE, fenetre[1] - hauteur)),
    width: TAILLE_BULLE.largeur,
    height: hauteur,
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
  /** La vue d'une appli de site ouverte (bornes, barre, disponibilité du mode) ; null si sa fenêtre est fermée. */
  vueSite?(id: string): VueDesignSite | null;
  /** Les applis de site (projetSuivi : null si l'id n'y est plus). */
  sites?(): Promise<{ id: string; nom: string }[]>;
  /** La mention info de la barre d'une appli de site. */
  messageSite?(id: string, texte: string): void;
  /** Replie le menu du chevron d'une appli de site (la vue reprend sa place) avant d'armer le viseur. */
  fermerMenuSite?(id: string): Promise<void>;
}

/**
 * Le mode design de chaque cible (onglet actif d'une fenêtre principale, fenêtre d'appli) : le viseur armé tant que le
 * mode est actif ; à chaque capture, la bulle du calque ; la remarque va au panier du projet suivi, puis le viseur est
 * réarmé. Un second basculement, Échap dans la page, une navigation vers un autre document, un autre onglet ou la
 * fermeture arrêtent le mode (le panier reste).
 */
export class ServiceDesign {
  private readonly sessions = new Map<string, Session>();
  /** Message d'indisponibilité montré, par clé : la page et l'interface écoutées, et de quoi retirer l'écoute. */
  private readonly ecoutesMessage = new Map<string, { wc: WebContents; detacher: () => void }>();
  readonly calques = new Calques();

  constructor(private readonly o: OptionsServiceDesign) {}

  private vue(c: CibleDesign): VueCible | null {
    if (c.type === "fenetre") return this.o.vueOnglet(c.fenetreId);
    if (c.type === "site") return this.vueSite(c.id);
    const f = this.o.fenetreApp(c.dossier);
    if (!f || f.isDestroyed() || f.webContents.isDestroyed()) return null;
    const [width = 0, height = 0] = f.getContentSize();
    return { wc: f.webContents, bornes: { x: 0, y: 0, width, height }, fenetre: f, url: f.webContents.getURL() };
  }

  private vueSite(id: string): VueDesignSite | null {
    const v = this.o.vueSite?.(id) ?? null;
    return v && !v.wc.isDestroyed() && !v.fenetre.isDestroyed() ? v : null;
  }

  private async projetDe(c: CibleDesign, url: string): Promise<ProjetSuivi | null> {
    // Appli de site : son projet dès que sa fenêtre est ouverte, même là où le mode est indisponible (compteur, panier).
    if (c.type === "site") {
      const v = this.vueSite(c.id);
      return v ? projetPourSite(c.id, v.nom) : null;
    }
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
    if (p.startsWith("site-")) {
      const id = p.slice(5);
      const site = (await this.o.sites?.())?.find((x) => x.id === id);
      return site ? projetPourSite(id, site.nom) : null;
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
    if (!projet) {
      const indisponible = c.type === "site" ? INDISPONIBLE_DESIGN_SITE : INDISPONIBLE_DESIGN;
      return { actif: false, projet: null, indisponible, destination: null, sansDestination: null, panier: 0, nom: "" };
    }
    const panier = (await this.o.remarques.panier(projet.projet)).length;
    // Appli de site : le projet est connu même là où le mode ne se lance pas (accueil, carte d'accord, connexion…).
    const indisponible = c.type === "site" && !s && !this.vueSite(c.id)?.disponible ? INDISPONIBLE_DESIGN_SITE : null;
    return { actif: !!s, projet, indisponible, ...this.destination(projet), panier, nom: this.nom(projet) };
  }

  /** La vue et le projet où lancer le mode ; null s'il y est indisponible (rien n'est alors injecté). */
  private async aLancer(c: CibleDesign): Promise<{ v: VueCible; projet: ProjetSuivi } | null> {
    if (c.type !== "site") {
      const v = this.vue(c);
      if (!v) return null;
      const projet = await this.projetDe(c, v.url);
      // Onglet hors des projets suivis : on dit pourquoi rien ne se passe.
      if (!projet && c.type === "fenetre") this.montrerIndisponible(cleCible(c), v);
      return projet ? { v, projet } : null;
    }
    const avant = this.vueSite(c.id);
    if (!avant) return null;
    if (!avant.disponible) {
      this.o.messageSite?.(c.id, INDISPONIBLE_DESIGN_SITE);
      return null;
    }
    // Le menu du chevron se replie d'abord : la vue reprend sa place, ses bornes sont relues ensuite.
    await this.o.fermerMenuSite?.(c.id);
    const v = this.vueSite(c.id);
    if (!v) return null;
    if (!v.disponible) {
      this.o.messageSite?.(c.id, INDISPONIBLE_DESIGN_SITE);
      return null;
    }
    return { v, projet: projetPourSite(c.id, v.nom) };
  }

  async basculer(c: CibleDesign): Promise<void> {
    const cle = cleCible(c);
    if (this.sessions.has(cle)) return this.arreter(c);
    const pret = await this.aLancer(c);
    // Indisponible : rien n'est injecté dans la page.
    if (!pret || this.sessions.has(cle) || pret.v.wc.isDestroyed()) return;
    const { v, projet } = pret;
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

  /**
   * Le message d'indisponibilité en haut à droite de la vue de l'onglet. La frappe suivante (dans la page ou dans
   * l'interface de la fenêtre) le ferme : l'écoute est posée une fois et retirée quand le message disparaît.
   */
  private montrerIndisponible(cle: string, v: VueCible): void {
    if (this.sessions.has(cle)) return;
    const ecoute = this.ecoutesMessage.get(cle);
    if (ecoute && ecoute.wc !== v.wc) this.oublierEcouteMessage(cle);
    if (!this.ecoutesMessage.has(cle)) {
      const interfaceFenetre = v.fenetre.webContents;
      const frappe = (_e: unknown, entree: Input) => {
        if (entree.type !== "keyDown") return;
        this.oublierEcouteMessage(cle);
        this.calques.fermerMessage(cle);
      };
      v.wc.on("before-input-event", frappe);
      interfaceFenetre.on("before-input-event", frappe);
      this.ecoutesMessage.set(cle, {
        wc: v.wc,
        detacher: () => {
          if (!v.wc.isDestroyed()) v.wc.off("before-input-event", frappe);
          if (!interfaceFenetre.isDestroyed()) interfaceFenetre.off("before-input-event", frappe);
        },
      });
    }
    const place = { x: v.bornes.x + v.bornes.width - MARGE_MESSAGE - LARGEUR_MESSAGE, y: v.bornes.y + MARGE_MESSAGE, width: LARGEUR_MESSAGE, height: HAUTEUR_MESSAGE };
    this.calques.montrerMessage(cle, v.fenetre, place, INDISPONIBLE_DESIGN, () => this.oublierEcouteMessage(cle));
  }

  private oublierEcouteMessage(cle: string): void {
    const e = this.ecoutesMessage.get(cle);
    if (!e) return;
    this.ecoutesMessage.delete(cle);
    e.detacher();
  }

  /** Rend le clavier à la page de la session (et sa fenêtre d'appli au premier plan, hors tests invisibles). */
  private rendreClavier(s: Session): void {
    if ((s.cible.type === "app" || s.cible.type === "site") && process.env.WEBAIOS_INVISIBLE !== "1" && !s.fenetre.isDestroyed()) s.fenetre.focus();
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
    // Appli de site : rien n'est lu dans le monde de la page, la source reste inconnue.
    const site = s.cible.type === "site";
    const source = site ? null : await lireSource(s.wc, capture.selecteur);
    const png = await capturerElement(s.wc, capture.rect, capture.vue);
    if (!this.actuelle(s, g)) return;
    const { rect, ...contexte } = capture;
    s.attente = { contexte: { ...contexte, source }, capture: png };
    const v = this.vue(s.cible);
    if (!v || v.wc !== s.wc || s.fenetre.isDestroyed()) return this.arreter(s.cible);
    const [l = 0, h = 0] = s.fenetre.getContentSize();
    const zoom = s.wc.isDestroyed() ? 1 : s.wc.getZoomFactor();
    const place = placeBulle(rect, zoom, v.bornes, [l, h], site ? { hautMin: v.bornes.y, hauteur: TAILLE_BULLE_SITE.hauteur } : {});
    this.calques.montrerBulle(s.cle, s.fenetre, place, {
      mode: "bulle",
      message: null,
      projet: s.projet.projet,
      etiquette: contexte.etiquette,
      source: sourceTexte(source),
      ...this.destination(s.projet),
      avertissement: site ? AVERTISSEMENT_CAPTURE_SITE : null,
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

  /** « Annuler » (Échap) de la bulle : rien n'est ajouté, le viseur est réarmé. Sans bulle : ferme le message et le panier du calque. */
  annuler(c: CibleDesign): void {
    const s = this.sessions.get(cleCible(c));
    if (!s?.attente) {
      // Clic sur le message d'indisponibilité, « Fermer » du panier.
      this.oublierEcouteMessage(cleCible(c));
      this.calques.fermerMessage(cleCible(c));
      return this.calques.fermerPanier(cleCible(c));
    }
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
    this.oublierEcouteMessage(cleCible(c));
    this.calques.oublier(cleCible(c));
  }

  /** « Panier » d'une fenêtre d'appli : le calque de la fenêtre montre le panier de l'appli (sous la barre d'une appli de site). */
  async ouvrirPanier(c: CibleDesign): Promise<void> {
    const v = this.vue(c);
    const projet = await this.projetCourant(c);
    if (!v || !projet) return;
    const contexte: ContexteCalque = { mode: "panier", message: null, projet: projet.projet, etiquette: "", source: null, ...this.destination(projet), avertissement: null };
    const site = c.type === "site" ? this.vueSite(c.id) : null;
    if (site) this.calques.montrerPanier(cleCible(c), v.fenetre, contexte, site.barre + 12);
    else this.calques.montrerPanier(cleCible(c), v.fenetre, contexte);
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
    if (cle.startsWith("fenetre:")) return { type: "fenetre", fenetreId: cle.slice(8) };
    if (cle.startsWith("site:")) return { type: "site", id: cle.slice(5) };
    return { type: "app", dossier: cle.slice(4) };
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
