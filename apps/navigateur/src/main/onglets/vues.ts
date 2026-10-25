import { BrowserWindow, WebContentsView, type Session, type WebContents } from "electron";
import type { Action, Bornes, CommandeOnglet } from "../../commun/api";
import type { EtatNavigateur, IdFenetre, IdOnglet, Onglet } from "../../commun/modele";
import { brancherEvenements } from "./evenements";

/** Préférences de toute page web : bac à sable, aucun preload. */
export function preferencesWeb(session: Session) {
  return { session, sandbox: true, contextIsolation: true, nodeIntegration: false };
}

/**
 * Synchronise les WebContentsView avec l'état : une vue par onglet chargé, créée à sa première activation,
 * attachée seulement quand l'onglet est actif dans sa fenêtre.
 */
export class GestionnaireVues {
  private vues = new Map<IdOnglet, WebContentsView>();
  private attachees = new Map<IdFenetre, IdOnglet>();
  private zones = new Map<IdFenetre, Bornes>();

  constructor(private readonly o: { session: Session; fenetres: Map<IdFenetre, BrowserWindow>; agir: (a: Action) => void }) {}

  synchroniser(etat: EtatNavigateur): void {
    for (const [id, vue] of this.vues) if (!etat.onglets[id]) this.detruireVue(id, vue);

    for (const f of etat.fenetres) {
      const fenetre = this.o.fenetres.get(f.id);
      if (!fenetre || fenetre.isDestroyed()) continue;
      const actif = f.actif[f.espaceActif];
      const onglet = actif ? etat.onglets[actif] : undefined;
      if (onglet && !this.vues.has(onglet.id)) this.creerVue(onglet);
      // Une page plantée est remplacée par le message de l'interface.
      const cible = onglet && !onglet.plante ? onglet.id : undefined;
      const courante = this.attachees.get(f.id);
      if (courante === cible) continue;
      if (courante) {
        const v = this.vues.get(courante);
        if (v) fenetre.contentView.removeChildView(v);
        this.attachees.delete(f.id);
      }
      if (cible) {
        const v = this.vues.get(cible)!;
        fenetre.contentView.addChildView(v);
        this.placer(f.id, v);
        this.attachees.set(f.id, cible);
      }
    }
  }

  bornes(fenetreId: IdFenetre, b: Bornes): void {
    this.zones.set(fenetreId, b);
    const id = this.attachees.get(fenetreId);
    const v = id && this.vues.get(id);
    if (v) this.placer(fenetreId, v);
  }

  vue(id: IdOnglet): WebContents | null {
    return this.vues.get(id)?.webContents ?? null;
  }

  /** Charge `url` dans l'onglet ; un onglet sans vue la chargera à sa création. */
  naviguer(id: IdOnglet, url: string): void {
    const wc = this.vue(id);
    if (wc) void wc.loadURL(url).catch(() => {});
    else this.o.agir({ type: "majOnglet", id, champs: { url } });
  }

  commande(id: IdOnglet, c: CommandeOnglet): void {
    const wc = this.vue(id);
    if (!wc) return;
    if (c === "reculer") wc.navigationHistory.goBack();
    else if (c === "avancer") wc.navigationHistory.goForward();
    else if (c === "recharger") wc.reload();
    else if (c === "arreter") wc.stop();
  }

  detruire(): void {
    for (const [id, vue] of this.vues) this.detruireVue(id, vue);
  }

  private creerVue(onglet: Onglet): void {
    const vue = new WebContentsView({ webPreferences: preferencesWeb(this.o.session) });
    const wc = vue.webContents;
    this.vues.set(onglet.id, vue);
    brancherEvenements(wc, onglet.id, this.o.agir);
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === "new-window") {
        // Popup (OAuth…) : vraie fenêtre, même session, sans l'interface WebAiOs.
        return {
          action: "allow",
          overrideBrowserWindowOptions: { width: 500, height: 650, webPreferences: preferencesWeb(this.o.session) },
        };
      }
      this.o.agir({ type: "ouvrirOnglet", fenetreId: onglet.fenetreId, url, apres: onglet.id, activer: disposition !== "background-tab" });
      return { action: "deny" };
    });
    if (onglet.zoom !== 1) wc.setZoomFactor(onglet.zoom);
    void wc.loadURL(onglet.url).catch(() => {});
  }

  private placer(fenetreId: IdFenetre, vue: WebContentsView): void {
    const b = this.zones.get(fenetreId);
    if (b) vue.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.largeur), height: Math.round(b.hauteur) });
  }

  private detruireVue(id: IdOnglet, vue: WebContentsView): void {
    for (const [f, o] of this.attachees) {
      if (o !== id) continue;
      const fenetre = this.o.fenetres.get(f);
      if (fenetre && !fenetre.isDestroyed()) fenetre.contentView.removeChildView(vue);
      this.attachees.delete(f);
    }
    this.vues.delete(id);
    if (!vue.webContents.isDestroyed()) vue.webContents.close();
  }
}
