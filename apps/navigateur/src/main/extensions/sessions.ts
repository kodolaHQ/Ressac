import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { app, session as sessionsElectron, type BrowserWindow, type Session, type WebContents } from "electron";
import { ElectronChromeExtensions } from "electron-chrome-extensions";
import { chargeesDans, lireCle, type EtatExtensions, type IdProfil } from "@webaios/noyau";
import type { EtatNavigateur, IdEspace, IdFenetre } from "../../commun/modele";

/** Où ouvrir l'onglet demandé par une extension : une fenêtre et un espace du profil de l'extension. */
export interface CibleOnglet {
  fenetreId: IdFenetre;
  espaceId: IdEspace;
}

/** Le profil sert à au moins un espace privé : aucune extension de l'agent n'y est chargée. */
export function profilPrive(etat: EtatNavigateur, profil: IdProfil): boolean {
  return etat.espaces.some((e) => e.profil === profil && e.prive);
}

/**
 * L'onglet d'une extension s'ouvre dans l'espace actif de la fenêtre au premier plan s'il utilise ce profil, sinon dans
 * le premier espace de ce profil de cette fenêtre, sinon dans la première fenêtre qui en a un ; jamais dans un espace
 * d'un autre profil (null : aucun espace n'utilise ce profil).
 */
export function cibleOnglet(etat: EtatNavigateur, profil: IdProfil, premierPlan: IdFenetre | undefined): CibleOnglet | null {
  const espaces = etat.espaces.filter((e) => e.profil === profil);
  if (espaces.length === 0) return null;
  const fenetres = [...etat.fenetres.filter((f) => f.id === premierPlan), ...etat.fenetres.filter((f) => f.id !== premierPlan)];
  for (const f of fenetres) {
    if (espaces.some((e) => e.id === f.espaceActif)) return { fenetreId: f.id, espaceId: f.espaceActif };
    const premier = espaces.find((e) => e.id in f.ordre);
    if (premier) return { fenetreId: f.id, espaceId: premier.id };
  }
  return null;
}

/** Dossier chargé pour une clé : `store/<id>/<version>_0` (Store), `copies/<dossier>` (agent) ; null si la clé est invalide. */
export function cheminExtension(dossier: string, cle: string, e: EtatExtensions): string | null {
  const lue = lireCle(cle);
  const entree = e.extensions[cle];
  if (!lue || !entree) return null;
  return lue.source === "store" ? join(dossier, "store", lue.id, `${entree.version}_0`) : join(dossier, "copies", lue.id);
}

/** Ce que la bibliothèque laisse voir de ses rouages (version figée 4.10.0) : son routeur d'API. */
interface Rouages {
  ctx?: { router?: { handle(nom: string, f: (evenement: { extension?: Electron.Extension }, ...args: unknown[]) => unknown): void } };
}

let fenetresNeutralisees = false;
let protocoleCrx = false;

/**
 * Les extensions dans les sessions des profils de connexion : une instance d'`ElectronChromeExtensions` par session de
 * profil (jamais `session.defaultSession`, ni la lecture publique, ni les icônes, ni les applis : seul `brancher` en crée,
 * et seules les sessions de profil y passent), branchée sur les vues des onglets par `ongletCree` / `ongletActive` /
 * `ongletDetruit` (appelés par `GestionnaireVues`). `synchroniser` charge dans chaque session les clés que le registre y
 * active (`chargeesDans`) et retire les autres.
 */
export class ExtensionsProfils {
  private instances = new Map<IdProfil, { session: Session; extensions: ElectronChromeExtensions }>();
  /** Par profil : clé → extension chargée (id Chromium, dossier). */
  private chargees = new Map<IdProfil, Map<string, { id: string; chemin: string }>>();
  private erreurs = new Map<string, string>();
  private dernier: EtatExtensions | undefined;
  private file: Promise<void> = Promise.resolve();
  /** Pendant nos propres appels à la bibliothèque, ses rappels `selectTab` / `removeTab` ne reviennent pas vers WebAiOs. */
  private echo = false;

  constructor(
    private readonly o: {
      /** `<userData>/extensions`. */
      dossier: string;
      etat: () => EtatNavigateur;
      /** La fenêtre principale au premier plan (ou la dernière utilisée). */
      premierPlan: () => IdFenetre | undefined;
      /** Ouvre un onglet ; sa vue (dans la session du profil) ou null. */
      ouvrirOnglet(cible: CibleOnglet, url: string, actif: boolean): Promise<WebContents | null>;
      /** La fenêtre principale d'une vue d'onglet. */
      fenetreDe(wc: WebContents): BrowserWindow | null;
      /** Une extension active un onglet (`tabs.update({ active: true })`). */
      activer(wc: WebContents): void;
      /** Une extension ferme un onglet (`tabs.remove`) : `GestionnaireVues.fermer`. */
      fermer(wc: WebContents): void;
      /** Mode invisible (tests) : aucune fenêtre montrée, aucune notification. */
      invisible: boolean;
      /** Tests : les notifications des extensions y sont notées (une ligne JSON), jamais montrées. */
      fichierNotifications?: string;
    },
  ) {
    // Les popups d'action, et toute autre fenêtre, restent cachées pendant les tests (yeux de l'utilisateur).
    if (o.invisible && !fenetresNeutralisees) {
      fenetresNeutralisees = true;
      app.on("browser-window-created", (_e, f) => {
        f.show = () => {};
        f.showInactive = () => {};
        f.focus = () => {};
      });
    }
  }

  /** Équipe la session d'un profil (une fois) et y charge ses extensions si l'état est déjà connu. */
  brancher(s: Session, profil: IdProfil): void {
    if (this.instances.has(profil) || ElectronChromeExtensions.fromSession(s)) return;
    if (!protocoleCrx) {
      protocoleCrx = true;
      // Icônes des boutons d'extension (`crx://`), affichées par l'interface.
      ElectronChromeExtensions.handleCRXProtocol(sessionsElectron.defaultSession);
    }
    const extensions = new ElectronChromeExtensions({
      session: s,
      createTab: (details) => this.creerOnglet(profil, details.url, details.active !== false),
      selectTab: (wc) => {
        if (!this.echo) this.o.activer(wc);
      },
      removeTab: (wc) => {
        if (!this.echo && !wc.isDestroyed()) this.o.fermer(wc);
      },
      // WebAiOs n'ouvre pas de fenêtre pour une extension : un onglet, choisi de la même façon.
      createWindow: async (details) => {
        const url = Array.isArray(details.url) ? details.url[0] : details.url;
        const [, fenetre] = await this.creerOnglet(profil, url, details.focused !== false);
        return fenetre;
      },
      // Ni fermeture de fenêtre principale par une extension, ni destruction par la bibliothèque.
      removeWindow: () => {},
      requestPermissions: async () => false,
    });
    if (this.o.invisible || this.o.fichierNotifications) this.detournerNotifications(extensions);
    this.instances.set(profil, { session: s, extensions });
    this.chargees.set(profil, new Map());
    if (this.dernier) void this.synchroniser(this.dernier);
  }

  /** Charge et retire les extensions de chaque session branchée selon l'état ; un appel à la fois. */
  synchroniser(e: EtatExtensions): Promise<void> {
    this.dernier = e;
    this.file = this.file
      .then(() => this.appliquer())
      .catch((erreur: unknown) => console.error("[extensions] synchronisation :", erreur));
    return this.file;
  }

  /** La dernière erreur de chargement de chaque clé (effacée quand elle se charge). */
  erreursChargement(): Map<string, string> {
    return new Map(this.erreurs);
  }

  /** Une vue d'onglet vient d'être créée : l'extension la voit comme un onglet de cette fenêtre. */
  ongletCree(wc: WebContents, fenetre: BrowserWindow): void {
    const x = this.instanceDe(wc);
    if (!x) return;
    this.sansEcho(() => x.addTab(wc, fenetre));
  }

  ongletActive(wc: WebContents): void {
    const x = this.instanceDe(wc);
    if (!x) return;
    this.sansEcho(() => x.selectTab(wc));
  }

  ongletDetruit(wc: WebContents): void {
    const x = this.instanceDe(wc);
    if (!x || wc.isDestroyed()) return;
    this.sansEcho(() => x.removeTab(wc));
  }

  private instanceDe(wc: WebContents): ElectronChromeExtensions | undefined {
    for (const { session, extensions } of this.instances.values()) if (session === wc.session) return extensions;
    return undefined;
  }

  private sansEcho(f: () => void): void {
    const avant = this.echo;
    this.echo = true;
    try {
      f();
    } finally {
      this.echo = avant;
    }
  }

  private async creerOnglet(profil: IdProfil, url: string | undefined, actif: boolean): Promise<[WebContents, BrowserWindow]> {
    const cible = cibleOnglet(this.o.etat(), profil, this.o.premierPlan());
    if (!cible) throw new Error("Aucun espace n'utilise le profil de cette extension : onglet refusé");
    const wc = await this.o.ouvrirOnglet(cible, url || "about:blank", actif);
    const fenetre = wc && this.o.fenetreDe(wc);
    if (!wc || !fenetre) throw new Error("Onglet non ouvert");
    return [wc, fenetre];
  }

  private async appliquer(): Promise<void> {
    const e = this.dernier;
    if (!e) return;
    const etat = this.o.etat();
    await Promise.all([...this.instances].map(([profil, { session }]) => this.appliquerProfil(e, profil, session, profilPrive(etat, profil))));
  }

  private async appliquerProfil(e: EtatExtensions, profil: IdProfil, s: Session, prive: boolean): Promise<void> {
    const chargees = this.chargees.get(profil)!;
    const voulues = new Map<string, string>();
    for (const cle of chargeesDans(e, profil, prive)) {
      const chemin = cheminExtension(this.o.dossier, cle, e);
      if (chemin) voulues.set(cle, chemin);
    }
    for (const [cle, c] of chargees) {
      if (voulues.get(cle) === c.chemin) continue;
      try {
        s.extensions.removeExtension(c.id);
      } catch (erreur) {
        console.error(`[extensions] ${cle} non retirée du profil ${profil} :`, erreur);
      }
      chargees.delete(cle);
    }
    for (const [cle, chemin] of voulues) {
      if (chargees.has(cle)) continue;
      try {
        const ext = await s.extensions.loadExtension(chemin, { allowFileAccess: false });
        chargees.set(cle, { id: ext.id, chemin });
        this.erreurs.delete(cle);
        // Rien n'assure qu'un service worker MV3 démarre au chargement : ses règles et son onInstalled en dépendent.
        if ((ext.manifest as { background?: unknown }).background) {
          await s.serviceWorkers.startWorkerForScope(ext.url).catch((erreur: unknown) => console.error(`[extensions] fond de ${cle} non démarré :`, erreur));
        }
      } catch (erreur) {
        this.erreurs.set(cle, (erreur as Error).message);
        console.error(`[extensions] ${cle} non chargée dans le profil ${profil} :`, erreur);
      }
    }
  }

  /**
   * `chrome.notifications` de la bibliothèque montre de vraies notifications de macOS : en tests, elles sont notées dans
   * le fichier des tests (ou jetées), jamais montrées.
   */
  private detournerNotifications(extensions: ElectronChromeExtensions): void {
    const routeur = (extensions as unknown as Rouages).ctx?.router;
    if (!routeur) return console.error("[extensions] notifications non détournées : la bibliothèque a changé");
    const fichier = this.o.fichierNotifications;
    routeur.handle("notifications.create", ({ extension }, a, b) => {
      const id = typeof a === "string" ? a : "guid";
      const opts = (typeof a === "object" ? a : b) as { title?: unknown; message?: unknown } | undefined;
      if (fichier) appendFileSync(fichier, JSON.stringify({ titre: String(opts?.title ?? ""), texte: String(opts?.message ?? ""), extension: extension?.id }) + "\n");
      return id;
    });
  }
}
