import { WebContentsView, type BrowserWindow, type Rectangle, type WebContents } from "electron";
import { join } from "node:path";
import { ARG_CALQUE, CANAUX } from "../../commun/canaux";
import type { ContexteCalque } from "../../commun/api";

/** Panier d'une fenêtre d'appli : 340 px à droite, toute la hauteur moins 24 (12 px des bords), ou sous la barre d'une appli de site. */
const MARGE = 12;
const LARGEUR_PANIER = 340;
/** Le message d'indisponibilité : fermé seul au bout de 4 s. */
export const DUREE_MESSAGE_MS = 4000;
/** Le message : une boîte de 360×56 en haut à droite de la vue de l'onglet. */
export const TAILLE_MESSAGE = { largeur: 360, hauteur: 56 };

interface Calque {
  vue: WebContentsView;
  fenetre: BrowserWindow;
  /** Ce que montre le calque ; null : retiré de la fenêtre. */
  bulle: { place: Rectangle; contexte: ContexteCalque } | null;
  panier: ContexteCalque | null;
  /** Le message d'indisponibilité, montré seulement sans bulle ni panier ; fermé seul après `DUREE_MESSAGE_MS`. */
  message: { place: Rectangle; texte: string; minuterie: ReturnType<typeof setTimeout>; fermeture?: () => void } | null;
  /** Haut du panier dans la fenêtre : 12 px, ou sous la barre (et le menu) d'une appli de site. */
  margeHaute: number;
  /** Retire les écouteurs posés sur la fenêtre (un calque recréé n'en ajoute pas à chaque fois). */
  detacher: () => void;
}

/**
 * Le calque du mode design : une `WebContentsView` transparente par fenêtre (interface WebAiOs, session par défaut,
 * jamais celle de la page), posée au-dessus de la page. Il montre la bulle d'une remarque, sinon le panier (fenêtre
 * d'appli). Le process principal reconnaît sa cible à l'expéditeur (`cibleDe`), jamais à ce que dit la vue.
 */
export class Calques {
  private readonly calques = new Map<string, Calque>();

  /** `cle` : `fenetre:<id>` ou `app:<dossier>`. */
  private assurer(cle: string, fenetre: BrowserWindow): Calque {
    const existant = this.calques.get(cle);
    if (existant && existant.fenetre === fenetre && !existant.vue.webContents.isDestroyed()) return existant;
    if (existant) this.oublier(cle);
    const vue = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: [`${ARG_CALQUE}${cle}`],
      },
    });
    vue.setBackgroundColor("#00000000");
    const c: Calque = { vue, fenetre, bulle: null, panier: null, message: null, margeHaute: MARGE, detacher: () => undefined };
    this.calques.set(cle, c);
    const query = { cible: cle };
    if (process.env.ELECTRON_RENDERER_URL) void vue.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL}/design.html?cible=${encodeURIComponent(cle)}`).catch(() => {});
    else void vue.webContents.loadFile(join(__dirname, "../renderer/design.html"), { query }).catch(() => {});
    const redimensionner = (): void => {
      if (this.calques.get(cle) === c) this.placer(c);
    };
    const fermee = (): void => {
      if (this.calques.get(cle) === c) this.oublier(cle);
    };
    fenetre.on("resize", redimensionner);
    fenetre.once("closed", fermee);
    c.detacher = () => {
      if (fenetre.isDestroyed()) return;
      fenetre.off("resize", redimensionner);
      fenetre.off("closed", fermee);
    };
    return c;
  }

  /** Place la vue d'après ce qu'elle montre ; la retire de la fenêtre si elle ne montre rien. */
  private placer(c: Calque): void {
    if (c.fenetre.isDestroyed() || c.vue.webContents.isDestroyed()) return;
    const enfants = c.fenetre.contentView.children;
    if (!c.bulle && !c.panier && !c.message) {
      if (enfants.includes(c.vue)) c.fenetre.contentView.removeChildView(c.vue);
      return;
    }
    if (c.bulle) c.vue.setBounds(c.bulle.place);
    else if (!c.panier && c.message) c.vue.setBounds(c.message.place);
    else {
      const [l = 0, h = 0] = c.fenetre.getContentSize();
      c.vue.setBounds({ x: Math.max(0, l - MARGE - LARGEUR_PANIER), y: c.margeHaute, width: Math.min(LARGEUR_PANIER, l), height: Math.max(0, h - c.margeHaute - MARGE) });
    }
    // Ajoutée (ou rajoutée) en dernier : au-dessus de la page et de la vue d'un onglet attachée depuis.
    c.fenetre.contentView.addChildView(c.vue);
  }

  montrerBulle(cle: string, fenetre: BrowserWindow, place: Rectangle, contexte: ContexteCalque): void {
    const c = this.assurer(cle, fenetre);
    c.bulle = { place, contexte };
    // Le message n'a plus lieu d'être : une bulle s'ouvre.
    this.retirerMessage(c);
    this.placer(c);
    this.notifierUn(c);
    c.vue.webContents.focus();
  }

  fermerBulle(cle: string): void {
    const c = this.calques.get(cle);
    if (!c || !c.bulle) return;
    c.bulle = null;
    this.placer(c);
    this.notifierUn(c);
  }

  montrerPanier(cle: string, fenetre: BrowserWindow, contexte: ContexteCalque, margeHaute = MARGE): void {
    const c = this.assurer(cle, fenetre);
    c.panier = contexte;
    c.margeHaute = margeHaute;
    this.placer(c);
    this.notifierUn(c);
  }

  fermerPanier(cle: string): void {
    const c = this.calques.get(cle);
    if (!c || !c.panier) return;
    c.panier = null;
    this.placer(c);
    this.notifierUn(c);
  }

  /**
   * Le message d'indisponibilité : sans prendre le clavier, fermé seul après `DUREE_MESSAGE_MS` (un nouveau message
   * relance la minuterie). Jamais montré pendant une bulle. `fermeture` est appelé quand il disparaît (minuterie,
   * `fermerMessage`, bulle ou calque fermé), pas quand un nouveau message le remplace.
   */
  montrerMessage(cle: string, fenetre: BrowserWindow, place: Rectangle, texte: string, fermeture?: () => void): void {
    if (this.calques.get(cle)?.bulle) return;
    const c = this.assurer(cle, fenetre);
    if (c.message) clearTimeout(c.message.minuterie);
    const minuterie = setTimeout(() => {
      if (this.calques.get(cle) === c && c.message?.minuterie === minuterie) this.fermerMessage(cle);
    }, DUREE_MESSAGE_MS);
    c.message = { place, texte, minuterie, fermeture };
    this.placer(c);
    this.notifierUn(c);
  }

  fermerMessage(cle: string): void {
    const c = this.calques.get(cle);
    if (!c || !c.message) return;
    this.retirerMessage(c);
    this.placer(c);
    this.notifierUn(c);
  }

  private retirerMessage(c: Calque): void {
    const m = c.message;
    if (!m) return;
    c.message = null;
    clearTimeout(m.minuterie);
    m.fermeture?.();
  }

  /** Ce que la vue doit montrer : la bulle d'abord, sinon le panier, sinon le message. */
  contexte(cle: string): ContexteCalque | null {
    const c = this.calques.get(cle);
    if (!c) return null;
    if (c.bulle) return c.bulle.contexte;
    if (c.panier) return c.panier;
    if (!c.message) return null;
    // Un projet vide ne passe jamais ID_PROJET : l'IPC ne donne aucun panier à ce calque.
    return { mode: "message", message: c.message.texte, projet: "", etiquette: "", source: null, destination: null, sansDestination: null, avertissement: null };
  }

  /** La cible du calque `sender` ; undefined pour tout autre expéditeur. */
  cibleDe(sender: WebContents): string | undefined {
    for (const [cle, c] of this.calques) if (!c.vue.webContents.isDestroyed() && c.vue.webContents === sender) return cle;
    return undefined;
  }

  private notifierUn(c: Calque): void {
    if (!c.vue.webContents.isDestroyed()) c.vue.webContents.send(CANAUX.designChange, null);
  }

  /** Un panier ou un état a changé : chaque calque relit. */
  notifier(): void {
    for (const c of this.calques.values()) this.notifierUn(c);
  }

  /** La fenêtre est fermée ou change : la vue est fermée. */
  oublier(cle: string): void {
    const c = this.calques.get(cle);
    if (!c) return;
    this.calques.delete(cle);
    this.retirerMessage(c);
    c.detacher();
    if (!c.fenetre.isDestroyed() && c.fenetre.contentView.children.includes(c.vue)) c.fenetre.contentView.removeChildView(c.vue);
    if (!c.vue.webContents.isDestroyed()) c.vue.webContents.close();
  }
}
