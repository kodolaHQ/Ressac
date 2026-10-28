import { BrowserWindow, clipboard, dialog, Menu, WebContentsView, type Session, type WebContents } from "electron";
import type { Action, Bornes, CommandeOnglet } from "../../commun/api";
import { type EtatNavigateur, type IdFenetre, type IdOnglet, type Onglet } from "../../commun/modele";
import { zoneGauche, zoneSortie, type ZoneGauche } from "../../commun/revelation";
import { brancherCapture } from "./capture-texte";
import { brancherBalayage } from "./balayage";
import { attendreChargement } from "./chargement";
import { brancherEvenements, type NotesHistorique } from "./evenements";
import { entreesMenuPage } from "./menu-page";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
/** Texte d'une page transmis à l'agent, au plus. */
const LONGUEUR_TEXTE = 100_000;
/** Largeur maximale de la capture qui sert de fond flouté aux modales (px) : légère, le flou efface le détail. */
const LARGEUR_APERCU = 1024;

/** Préférences de toute page web : bac à sable, aucun preload. */
export function preferencesWeb(session: Session) {
  return { session, sandbox: true, contextIsolation: true, nodeIntegration: false };
}

/**
 * Ouvertures demandées par une page (onglet ou popup). Seul un window.open avec des dimensions (OAuth…) donne une
 * popup : vraie fenêtre, même session que la page qui l'ouvre, sans l'interface WebAiOs, dont le titre montre le site
 * (pas de barre d'adresse pour repérer un hameçonnage). Le reste (⇧clic, target=_blank…) devient un onglet.
 */
function gererOuvertures(
  wc: WebContents,
  ouvrirOnglet: (url: string, activer: boolean) => void,
  quandPopup: (popup: WebContents) => void,
): void {
  wc.setWindowOpenHandler(({ url, disposition, features }) => {
    if (disposition === "new-window" && features) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 500,
          height: 650,
          show: process.env.WEBAIOS_INVISIBLE !== "1", // tests automatiques : rien à l'écran
          webPreferences: preferencesWeb(wc.session),
        },
      };
    }
    ouvrirOnglet(url, disposition !== "background-tab");
    return { action: "deny" };
  });
  wc.on("did-create-window", (popup) => {
    popup.on("page-title-updated", (e, titre) => {
      e.preventDefault();
      let site = "";
      try {
        site = new URL(popup.webContents.getURL()).host;
      } catch {
        // URL sans hôte : le titre seul
      }
      popup.setTitle(site ? `${site} — ${titre}` : titre);
    });
    quandPopup(popup.webContents);
    // Une popup peut en ouvrir une autre (étapes d'une connexion) ; ses liens vont dans des onglets.
    gererOuvertures(popup.webContents, ouvrirOnglet, quandPopup);
  });
}

/**
 * Synchronise les WebContentsView avec l'état : une vue par onglet chargé, créée à sa première activation,
 * attachée seulement quand l'onglet est actif dans sa fenêtre.
 */
export class GestionnaireVues {
  private vues = new Map<IdOnglet, WebContentsView>();
  /** Session (profil de connexion) de chaque vue, celle de son onglet à sa création. */
  private sessions = new Map<IdOnglet, Session>();
  private attachees = new Map<IdFenetre, IdOnglet>();
  private zones = new Map<IdFenetre, Bornes>();
  /** Popups ouvertes depuis un onglet (directement ou par une autre popup) : leurs questions vont à cet onglet. */
  private popups = new Map<WebContents, IdOnglet>();
  /** Fermetures en cours (voir `fermer`), à abandonner si l'utilisateur reste sur la page. */
  private abandons = new Map<WebContents, () => void>();
  /** Zoom voulu par onglet, réappliqué à chaque navigation. */
  private zooms = new Map<IdOnglet, number>();

  constructor(
    private readonly o: {
      /** Session du profil de connexion de l'onglet. */
      sessionDe: (o: Onglet) => Session;
      fenetres: Map<IdFenetre, BrowserWindow>;
      agir: (a: Action) => void;
      /** Au-dessus d'une page, la souris change de zone par rapport au bord gauche de la fenêtre (mode compact). */
      zoneGauche?: (fenetreId: IdFenetre, zone: ZoneGauche) => void;
      historique?: NotesHistorique;
      /** Espace et caractère privé de l'onglet d'après l'état courant ; null : onglet disparu, rien à noter. */
      contexteHistorique?: (id: IdOnglet) => { espaceId: string; prive: boolean } | null;
      /** Mémoire de navigation : texte des pages vues dans les onglets (jamais les fenêtres d'apps ni les widgets d'accueil). */
      retenir?: (r: { url: string; espaceId: string; titre: string; texte: string }) => void;
      resultatRecherche?: (fenetreId: IdFenetre, r: { ongletId: IdOnglet; actif: number; total: number }) => void;
      pleinEcran?: (fenetreId: IdFenetre, actif: boolean) => void;
    },
  ) {}

  synchroniser(etat: EtatNavigateur): void {
    for (const [id, vue] of this.vues) {
      const onglet = etat.onglets[id];
      if (!onglet) this.detruireVue(id, vue);
      // Changement de profil de connexion : la page se rouvrira de zéro, à la même URL, dans la nouvelle session.
      else if (this.o.sessionDe(onglet) !== this.sessions.get(id)) {
        this.fermerPopups(id);
        this.detruireVue(id, vue);
      }
    }

    for (const f of etat.fenetres) {
      const fenetre = this.o.fenetres.get(f.id);
      if (!fenetre || fenetre.isDestroyed()) continue;
      const actif = f.actif[f.espaceActif];
      const onglet = actif ? etat.onglets[actif] : undefined;
      // Une page interne (`webaios:`) n'a pas de vue : c'est l'interface qui l'affiche, comme la page vide.
      const web = onglet && !onglet.url.startsWith("webaios:") ? onglet : undefined;
      if (web && !this.vues.has(web.id)) this.creerVue(web);
      // Une page plantée ou en erreur est remplacée par le message de l'interface.
      const cible = web && !web.plante && !web.erreur ? web.id : undefined;
      const courante = this.attachees.get(f.id);
      if (courante === cible) continue;
      if (courante) {
        const v = this.vues.get(courante);
        if (v) fenetre.contentView.removeChildView(v);
        this.attachees.delete(f.id);
        // Plus de page affichée (page vide, message d'erreur…) : le clavier revient à l'interface.
        if (!cible) fenetre.webContents.focus();
      }
      if (cible) {
        const v = this.vues.get(cible)!;
        fenetre.contentView.addChildView(v);
        this.placer(f.id, v);
        this.attachees.set(f.id, cible);
      }
    }
  }

  /**
   * Vue d'un onglet pour l'agent, même s'il n'a jamais été affiché : créée sans être attachée, à la taille de la
   * zone de contenu de sa fenêtre, et chargée (15 s au plus).
   */
  async assurerVue(onglet: Onglet): Promise<WebContents> {
    if (!this.vues.has(onglet.id)) this.creerVue(onglet);
    const vue = this.vues.get(onglet.id)!;
    if (this.fenetreDe(onglet.id) === undefined) {
      const z = this.zones.get(onglet.fenetreId);
      vue.setBounds({ x: 0, y: 0, width: Math.round(z?.largeur || 1024), height: Math.round(z?.hauteur || 768) });
    }
    const wc = vue.webContents;
    await attendreChargement(wc, 15_000);
    return wc;
  }

  /** Texte et sélection, lus dans un monde isolé : la page ne peut pas falsifier ce que l'agent reçoit. */
  async lireTexte(onglet: Onglet): Promise<{ texte: string; selection?: string }> {
    return this.lireTexteDe(await this.assurerVue(onglet));
  }

  async lireTexteDe(wc: WebContents): Promise<{ texte: string; selection?: string }> {
    const r = (await wc.executeJavaScriptInIsolatedWorld(999, [
      { code: `({ texte: (document.body?.innerText ?? "").slice(0, ${LONGUEUR_TEXTE}), selection: String(getSelection() ?? "") })` },
    ])) as { texte: string; selection: string };
    return r.selection ? { texte: r.texte, selection: r.selection } : { texte: r.texte };
  }

  async capturer(onglet: Onglet): Promise<Buffer> {
    return this.capturerDe(await this.assurerVue(onglet));
  }

  async capturerDe(wc: WebContents): Promise<Buffer> {
    return (await wc.capturePage(undefined, { stayHidden: true })).toPNG();
  }

  /**
   * Fond d'une modale : la page affichée dans la fenêtre, si c'est bien `ongletId`, en JPEG réduit (elle sera floutée).
   * null s'il n'y en a pas (page vide, page interne) ou si la capture échoue.
   */
  async apercu(fenetreId: IdFenetre, ongletId: IdOnglet): Promise<string | null> {
    const wc = this.attachees.get(fenetreId) === ongletId ? this.vues.get(ongletId)?.webContents : undefined;
    if (!wc || wc.isDestroyed() || wc.isCrashed()) return null;
    try {
      let image = await wc.capturePage(undefined, { stayHidden: true });
      if (image.isEmpty()) return null;
      if (image.getSize().width > LARGEUR_APERCU) image = image.resize({ width: LARGEUR_APERCU, quality: "good" });
      return `data:image/jpeg;base64,${image.toJPEG(70).toString("base64")}`;
    } catch {
      return null;
    }
  }

  /** Fenêtre fermée dont l'état est gardé (macOS) : ses pages se ferment et se recréeront à sa réouverture. */
  oublierFenetre(etat: EtatNavigateur, fenetreId: IdFenetre): void {
    for (const o of Object.values(etat.onglets)) {
      const vue = o.fenetreId === fenetreId ? this.vues.get(o.id) : undefined;
      if (vue) this.detruireVue(o.id, vue);
    }
    this.attachees.delete(fenetreId);
    this.zones.delete(fenetreId);
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
    if (wc) {
      void wc.loadURL(url).catch(() => {});
      wc.focus();
    }
    else this.o.agir({ type: "majOnglet", id, champs: { url } });
  }

  /** Onglet affiché par ce webContents, s'il s'agit d'une vue d'onglet. */
  /**
   * Fermeture voulue par l'utilisateur : la page peut d'abord demander confirmation (formulaire non enregistré). L'onglet
   * quitte l'état une fois la page fermée ; une page figée est fermée d'office au bout de 5 s.
   */
  fermer(id: IdOnglet): void {
    const wc = this.vues.get(id)?.webContents;
    const retirer = () => this.o.agir({ type: "fermerOnglet", id });
    if (!wc || wc.isDestroyed() || wc.isCrashed()) return retirer();
    const minuterie = setTimeout(retirer, 5000);
    const fini = () => {
      clearTimeout(minuterie);
      retirer();
    };
    wc.once("destroyed", fini);
    // « Rester sur la page » : la fermeture est abandonnée.
    this.abandons.set(wc, () => {
      clearTimeout(minuterie);
      wc.off("destroyed", fini);
    });
    wc.close({ waitForBeforeUnload: true });
  }

  ongletDe(wc: WebContents | null): IdOnglet | null {
    if (!wc) return null;
    for (const [id, v] of this.vues) if (v.webContents === wc) return id;
    return this.popups.get(wc) ?? null;
  }

  commande(id: IdOnglet, c: CommandeOnglet): void {
    const wc = this.vue(id);
    if (!wc) return;
    if (c === "reculer") wc.navigationHistory.goBack();
    else if (c === "avancer") wc.navigationHistory.goForward();
    else if (c === "recharger") wc.reload();
    else if (c === "rechargerSansCache") wc.reloadIgnoringCache();
    else if (c === "outils") wc.toggleDevTools();
    else if (c === "arreter") wc.stop();
    else if (c === "finRecherche") wc.stopFindInPage("clearSelection");
    else if (typeof c === "object" && "chercher" in c) {
      if (!c.chercher) {
        wc.stopFindInPage("clearSelection");
        const fenetreId = this.fenetreDe(id);
        if (fenetreId) this.o.resultatRecherche?.(fenetreId, { ongletId: id, actif: 0, total: 0 });
      } else wc.findInPage(c.chercher, { findNext: !c.suivant && !c.precedent, forward: !c.precedent });
    } else if (typeof c === "object" && "zoom" in c) {
      const actuel = wc.getZoomFactor();
      const cible = c.zoom === "zero" ? 1 : Math.round((actuel + (c.zoom === "plus" ? 0.1 : -0.1)) * 10) / 10;
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cible));
      wc.setZoomFactor(zoom);
      this.zooms.set(id, zoom);
      this.o.agir({ type: "majOnglet", id, champs: { zoom } });
    }
  }

  detruire(): void {
    for (const [id, vue] of this.vues) this.detruireVue(id, vue);
  }

  private creerVue(onglet: Onglet): void {
    const session = this.o.sessionDe(onglet);
    const vue = new WebContentsView({ webPreferences: preferencesWeb(session) });
    const wc = vue.webContents;
    this.vues.set(onglet.id, vue);
    this.sessions.set(onglet.id, session);
    const contexte = () => this.o.contexteHistorique?.(onglet.id) ?? null;
    brancherEvenements(wc, onglet.id, this.o.agir, this.o.historique, contexte);
    brancherBalayage(wc);
    if (this.o.retenir) brancherCapture(wc, contexte, this.o.retenir);
    gererOuvertures(
      wc,
      (url, activer) => this.o.agir({ type: "ouvrirOnglet", fenetreId: onglet.fenetreId, url, apres: onglet.id, activer }),
      (popup) => {
        this.popups.set(popup, onglet.id);
        popup.once("destroyed", () => this.popups.delete(popup));
      },
    );
    wc.on("will-prevent-unload", (e) => {
      const fenetre = this.o.fenetres.get(onglet.fenetreId);
      const options = {
        type: "question" as const,
        buttons: ["Quitter", "Rester"],
        defaultId: 1,
        cancelId: 1,
        message: "Quitter ce site ?",
        detail: "Les modifications que vous avez faites ne seront peut-être pas enregistrées.",
      };
      // Synchrone : la décision doit être prise pendant l'événement.
      const choix = fenetre && !fenetre.isDestroyed() ? dialog.showMessageBoxSync(fenetre, options) : dialog.showMessageBoxSync(options);
      if (choix === 0) e.preventDefault();
      else this.abandons.get(wc)?.();
      this.abandons.delete(wc);
    });
    // Zoom propre à l'onglet (Chromium le partage sinon entre tous les onglets d'un même site).
    wc.setZoomMode("isolated");
    this.zooms.set(onglet.id, onglet.zoom);
    wc.on("did-navigate", () => wc.setZoomFactor(this.zooms.get(onglet.id) ?? 1));
    wc.on("context-menu", (_e, params) => {
      const entrees = entreesMenuPage(params, {
        ouvrirOnglet: (url) => this.o.agir({ type: "ouvrirOnglet", fenetreId: onglet.fenetreId, url, apres: onglet.id, activer: false }),
        copier: (texte) => clipboard.writeText(texte),
        copierImage: (x, y) => wc.copyImageAt(x, y),
        remplacerMot: (mot) => wc.replaceMisspelling(mot),
        inspecter: (x, y) => wc.inspectElement(x, y),
      });
      const fenetre = this.o.fenetres.get(onglet.fenetreId);
      Menu.buildFromTemplate(entrees).popup(fenetre && !fenetre.isDestroyed() ? { window: fenetre } : {});
    });
    wc.on("found-in-page", (_e, r) => {
      this.o.resultatRecherche?.(onglet.fenetreId, { ongletId: onglet.id, actif: r.activeMatchOrdinal, total: r.matches });
    });
    wc.on("enter-html-full-screen", () => this.o.pleinEcran?.(onglet.fenetreId, true));
    wc.on("leave-html-full-screen", () => this.o.pleinEcran?.(onglet.fenetreId, false));
    // Position de la souris en px de fenêtre, notée au mouvement : la vue peut se décaler ensuite sous une souris
    // immobile (barre révélée), et c'est alors sa dernière vraie position qui compte quand elle quitte la page.
    let zone: ZoneGauche | null = null;
    let dernierX = Infinity;
    wc.on("before-mouse-event", (_e, souris) => {
      if (souris.type !== "mouseMove" && souris.type !== "mouseLeave") return;
      const sortie = souris.type === "mouseLeave";
      if (!sortie) dernierX = souris.x + vue.getBounds().x;
      const z = sortie ? zoneSortie(dernierX) : zoneGauche(dernierX);
      if (z !== zone) this.o.zoneGauche?.(onglet.fenetreId, z);
      // Sortie : la prochaine entrée sera transmise même dans la même zone (l'interface a pu en voir une autre entre-temps).
      zone = sortie ? null : z;
    });
    void wc.loadURL(onglet.url).catch(() => {});
  }

  /** Popups ouvertes depuis l'onglet : elles sont dans son ancienne session. */
  private fermerPopups(id: IdOnglet): void {
    for (const [popup, o] of this.popups) if (o === id && !popup.isDestroyed()) BrowserWindow.fromWebContents(popup)?.close();
  }

  private fenetreDe(id: IdOnglet): IdFenetre | undefined {
    for (const [f, o] of this.attachees) if (o === id) return f;
    return undefined;
  }

  private placer(fenetreId: IdFenetre, vue: WebContentsView): void {
    const b = this.zones.get(fenetreId);
    if (b) vue.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.largeur), height: Math.round(b.hauteur) });
  }

  private detruireVue(id: IdOnglet, vue: WebContentsView): void {
    for (const [f, o] of this.attachees) {
      if (o !== id) continue;
      const fenetre = this.o.fenetres.get(f);
      if (fenetre && !fenetre.isDestroyed()) {
        fenetre.contentView.removeChildView(vue);
        // La page affichée se ferme (⌘W) : le clavier revient à l'interface, sinon la frappe n'irait nulle part.
        fenetre.webContents.focus();
      }
      this.attachees.delete(f);
    }
    this.vues.delete(id);
    this.sessions.delete(id);
    this.zooms.delete(id);
    // Page déjà fermée (onglet fermé par l'utilisateur, voir `fermer`) : la vue n'a plus de webContents. Lire
    // `isDestroyed()` dessus lèverait, et `synchroniser` s'arrêterait avant d'afficher l'onglet suivant.
    const wc = vue.webContents as WebContents | undefined;
    if (wc && !wc.isDestroyed()) wc.close();
  }
}
