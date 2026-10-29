import { appendFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { app, ipcMain, session as sessionsElectron, type BrowserWindow, type IpcMainInvokeEvent, type Session, type WebContents } from "electron";
import { ElectronChromeExtensions } from "electron-chrome-extensions";
import { installChromeWebStore } from "electron-chrome-web-store";
import { chargeesDans, lireCle, type EtatExtensions, type IdProfil } from "@webaios/noyau";
import type { EtatNavigateur, IdEspace, IdFenetre } from "../../commun/modele";
import { connexionNative } from "./natif";

/** Canal du preload des correctifs (`src/preload/extensions.ts`) : service workers et pages `chrome-extension://`. */
export const CANAL_DEMARRAGE = "webaios:extension-demarrage";

/**
 * Ce que Chrome aurait fait au chargement, donné une fois par version et par profil : `installation` pour
 * `runtime.onInstalled`, et l'état des rulesets statiques remis aux valeurs du manifeste (`rulesets` activés,
 * `rulesetsInactifs` coupés), seulement cette fois-là : un ruleset coupé ensuite par l'extension reste coupé.
 * `agent` : extension de l'agent.
 */
export interface DemarrageExtension {
  installation: { reason: "install" | "update"; previousVersion?: string } | null;
  rulesets: string[];
  rulesetsInactifs: string[];
  agent: boolean;
}

/** Les ids des `rule_resources` du manifeste, à `enabled: true` (`actifs`) ou non (`inactifs`). */
export function rulesetsDuManifeste(manifeste: unknown): { actifs: string[]; inactifs: string[] } {
  const r = (manifeste as { declarative_net_request?: { rule_resources?: unknown } } | null)?.declarative_net_request?.rule_resources;
  const actifs: string[] = [];
  const inactifs: string[] = [];
  if (!Array.isArray(r)) return { actifs, inactifs };
  for (const x of r as unknown[]) {
    if (typeof x !== "object" || x === null || typeof (x as { id?: unknown }).id !== "string") continue;
    ((x as { enabled?: unknown }).enabled === true ? actifs : inactifs).push((x as { id: string }).id);
  }
  return { actifs, inactifs };
}

function cheminReel(chemin: string): string {
  try {
    return realpathSync(chemin);
  } catch {
    return resolve(chemin);
  }
}

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
  ctx?: { router?: { handle?(nom: string, f: (evenement: { extension?: Electron.Extension }, ...args: unknown[]) => unknown): void } };
}

/**
 * `chrome.notifications` de la bibliothèque montre de vraies notifications de macOS : en tests, elles sont notées dans
 * `fichier` (une ligne JSON `{ titre, texte, extension }`) ou jetées, jamais montrées. Lève si la bibliothèque a changé
 * et que le détournement est impossible : mieux vaut un profil sans extensions qu'une vraie notification.
 */
export function detournerNotifications(extensions: ElectronChromeExtensions, fichier: string | undefined): void {
  const routeur = (extensions as unknown as Rouages).ctx?.router;
  if (typeof routeur?.handle !== "function") throw new Error("notifications des extensions non détournables : la bibliothèque a changé");
  routeur.handle("notifications.create", ({ extension }, a, b) => {
    const id = typeof a === "string" ? a : "guid";
    const opts = (typeof a === "object" ? a : b) as { title?: unknown; message?: unknown } | undefined;
    if (fichier) appendFileSync(fichier, JSON.stringify({ titre: String(opts?.title ?? ""), texte: String(opts?.message ?? ""), extension: extension?.id }) + "\n");
    return id;
  });
}

let fenetresNeutralisees = false;
let protocoleCrx = false;
/** Les instances vivantes : le canal des pages (`ipcMain`, un seul par processus) cherche celle de la session. */
const instancesVivantes = new Set<ExtensionsProfils>();
let canalPagesPose = false;
/** Service workers dont le canal de démarrage est posé. */
const workersEcoutes = new WeakSet<object>();
/** Sessions équipées par la bibliothèque dans ce processus (chacune ajoute un écouteur à `app`). */
let sessionsEquipees = 0;

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
  /** Par profil : clé → dossier voulu (posé avant le chargement : un service worker peut démarrer pendant celui-ci). */
  private voulues = new Map<IdProfil, Map<string, string>>();
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
      /** Le preload des correctifs (`out/preload/extensions.js`). */
      preloadCorrectifs: string;
      /**
       * Note au registre la version démarrée dans ce profil (`vues[profil]`) : `nouvelle` si elle ne l'était pas encore,
       * avec la version vue avant (`precedente`, absente à la première installation).
       */
      noterVue(cle: string, profil: IdProfil, version: string): Promise<{ nouvelle: boolean; precedente?: string }>;
      /** `tabs.create`, `tabs.update`, `windows.create` d'une extension vers `url` ; absent : permis. */
      verifierUrl?(extension: Electron.Extension, url: string): boolean;
      /** `tabs.insertCSS` d'une extension dans un onglet à l'adresse `url` ; absent : permis. */
      verifierHote?(extension: Electron.Extension, url: string): boolean;
      /**
       * `beforeInstall` de la page du Chrome Web Store dans la session de ce profil (store.ts, `avantInstallation`) ;
       * absent : la page du Store n'est pas équipée.
       */
      avantInstallationStore?(s: Session, profil: IdProfil): (details: { id: string; frame: Electron.WebFrameMain }) => Promise<{ action: "allow" | "deny" }>;
      /** `chrome.management.uninstall` de la page du Store (crochet du correctif) : lève si elle ne peut pas être retirée. */
      desinstallerDepuisStore?(id: string): Promise<void>;
    },
  ) {
    instancesVivantes.add(this);
    if (!canalPagesPose) {
      canalPagesPose = true;
      ipcMain.handle(CANAL_DEMARRAGE, (e) => {
        for (const x of instancesVivantes) {
          const r = x.demarrageDepuisPage(e);
          if (r) return r;
        }
        throw new Error("Expéditeur refusé : pas une page d'extension chargée");
      });
    }
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
    // La bibliothèque ajoute un `app.on("web-contents-created")` par session équipée : sans cela, Node signalerait une
    // fuite d'écouteurs (10 par défaut) dès le dixième profil. La limite suit le nombre de sessions équipées.
    app.setMaxListeners(Math.max(app.getMaxListeners(), 10 + ++sessionsEquipees));
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
      // Crochets du correctif de la bibliothèque (patches/electron-chrome-extensions@4.10.0.patch).
      verifierUrl: (extension, url) => this.o.verifierUrl?.(extension, url) ?? true,
      verifierHote: (extension, url) => this.o.verifierHote?.(extension, url) ?? true,
      connectNative: connexionNative,
    });
    // Après ceux de la bibliothèque : `chrome` y est déjà complété.
    s.registerPreloadScript({ id: "webaios-extensions-fond", type: "service-worker", filePath: this.o.preloadCorrectifs });
    s.registerPreloadScript({ id: "webaios-extensions-page", type: "frame", filePath: this.o.preloadCorrectifs });
    // Comme le routeur de la bibliothèque : les IPC d'un service worker arrivent sur son propre `ipc`.
    s.serviceWorkers.on("running-status-changed", ({ runningStatus, versionId }) => {
      if (runningStatus !== "starting") return;
      const worker = s.serviceWorkers.getWorkerFromVersionID(versionId);
      if (!worker || workersEcoutes.has(worker) || !worker.scope.startsWith("chrome-extension://")) return;
      workersEcoutes.add(worker);
      const id = new URL(worker.scope).host;
      worker.ipc.handle(CANAL_DEMARRAGE, () => this.demarrage(profil, s, id, "fond"));
    });
    // Lève si c'est impossible : le profil n'est alors pas enregistré, et aucune extension n'y sera jamais chargée.
    if (this.o.invisible || this.o.fichierNotifications) detournerNotifications(extensions, this.o.fichierNotifications);
    this.instances.set(profil, { session: s, extensions });
    this.chargees.set(profil, new Map());
    // La page du Store dans ce profil : la bibliothèque ne charge rien (`loadExtensions: false`), ne met rien à jour, et
    // n'installe jamais elle-même (`beforeInstall` ne rend `allow` que pour une extension déjà chargée par nous).
    const avant = this.o.avantInstallationStore?.(s, profil);
    if (avant) {
      const desinstaller = this.o.desinstallerDepuisStore ?? (() => Promise.reject(new Error("Désinstallation depuis la page du Store non branchée")));
      void installChromeWebStore({
        session: s,
        extensionsPath: join(this.o.dossier, "store"),
        loadExtensions: false,
        autoUpdate: false,
        beforeInstall: avant,
        // Crochet du correctif : la bibliothèque n'efface jamais `store/<id>` elle-même (commun à tous les profils).
        uninstallHandler: (id) => desinstaller(id),
      }).catch(
        (erreur: unknown) => console.error(`[extensions] page du Store non équipée dans le profil ${profil} :`, erreur),
      );
    }
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

  /**
   * Retire tout de suite (de façon synchrone, hors de la file) les extensions de l'agent des profils qu'utilise désormais
   * un espace privé : appelé par l'abonné du magasin avant que les vues de l'espace privé ne chargent leur page. Une
   * extension dont le chargement est en cours est retirée dès qu'il finit (voir `appliquerProfil`).
   */
  retirerAgentsPrives(etat: EtatNavigateur): void {
    for (const [profil, { session }] of this.instances) {
      if (!profilPrive(etat, profil)) continue;
      const chargees = this.chargees.get(profil)!;
      for (const [cle, c] of chargees) {
        if (lireCle(cle)?.source !== "agent") continue;
        this.retirer(session, profil, cle, c.id);
        chargees.delete(cle);
      }
    }
  }

  /** L'instance ne répond plus sur le canal des pages (tests ; fin d'usage). */
  detruire(): void {
    instancesVivantes.delete(this);
  }

  /**
   * Canal des pages : null si l'expéditeur n'est pas dans une session de cette instance ; lève si ce n'est pas une
   * page `chrome-extension://` d'une extension chargée dans sa session.
   */
  demarrageDepuisPage(e: IpcMainInvokeEvent): Promise<DemarrageExtension> | null {
    const s = e.sender.session;
    const profil = [...this.instances].find(([, x]) => x.session === s)?.[0];
    if (profil === undefined) return null;
    let id = "";
    try {
      const url = new URL(e.senderFrame?.url ?? "");
      if (url.protocol === "chrome-extension:") id = url.host;
    } catch {
      // Adresse illisible : refusée plus bas.
    }
    if (!id || !s.extensions.getExtension(id)) throw new Error("Expéditeur refusé : pas une page d'extension chargée");
    return this.demarrage(profil, s, id, "page");
  }

  /**
   * Réponse au preload des correctifs. La première fois qu'une version démarre dans un profil (registre, `vues`) :
   * l'installation (`install`, ou `update` avec la version précédente) et les rulesets du manifeste ; ensuite rien. Une
   * page d'une extension qui a un fond ne reçoit jamais l'installation : c'est son fond qui la reçoit.
   */
  private async demarrage(profil: IdProfil, s: Session, id: string, contexte: "fond" | "page"): Promise<DemarrageExtension> {
    const vide = (agent: boolean): DemarrageExtension => ({ installation: null, rulesets: [], rulesetsInactifs: [], agent });
    const ext = s.extensions.getExtension(id);
    const cle = ext ? this.cleDe(profil, ext) : undefined;
    if (!ext || !cle) return vide(false);
    const agent = lireCle(cle)?.source === "agent";
    if (contexte === "page" && (ext.manifest as { background?: unknown }).background) return vide(agent);
    try {
      const vue = await this.o.noterVue(cle, profil, ext.version);
      if (!vue.nouvelle) return vide(agent);
      const { actifs, inactifs } = rulesetsDuManifeste(ext.manifest);
      return {
        installation: vue.precedente ? { reason: "update", previousVersion: vue.precedente } : { reason: "install" },
        rulesets: actifs,
        rulesetsInactifs: inactifs,
        agent,
      };
    } catch (erreur) {
      console.error(`[extensions] démarrage de ${cle} non noté :`, erreur);
      return vide(agent);
    }
  }

  /** La clé d'une extension chargée (ou en cours de chargement) dans ce profil. */
  private cleDe(profil: IdProfil, ext: Electron.Extension): string | undefined {
    for (const [cle, c] of this.chargees.get(profil) ?? []) if (c.id === ext.id) return cle;
    const reel = cheminReel(ext.path);
    for (const [cle, chemin] of this.voulues.get(profil) ?? []) if (cheminReel(chemin) === reel) return cle;
    return undefined;
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
    this.voulues.set(profil, voulues);
    for (const [cle, c] of chargees) {
      if (voulues.get(cle) === c.chemin) continue;
      this.retirer(s, profil, cle, c.id);
      chargees.delete(cle);
    }
    for (const [cle, chemin] of voulues) {
      if (chargees.has(cle)) continue;
      try {
        const ext = await s.extensions.loadExtension(chemin, { allowFileAccess: false });
        this.erreurs.delete(cle);
        // Le profil est devenu privé pendant le chargement : une extension de l'agent repart aussitôt.
        if (lireCle(cle)?.source === "agent" && profilPrive(this.o.etat(), profil)) {
          this.retirer(s, profil, cle, ext.id);
          continue;
        }
        chargees.set(cle, { id: ext.id, chemin });
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

  private retirer(s: Session, profil: IdProfil, cle: string, id: string): void {
    try {
      s.extensions.removeExtension(id);
    } catch (erreur) {
      console.error(`[extensions] ${cle} non retirée du profil ${profil} :`, erreur);
    }
  }
}
