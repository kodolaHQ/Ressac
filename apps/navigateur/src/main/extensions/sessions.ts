import { appendFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  app,
  ipcMain,
  session as sessionsElectron,
  webContents as tousLesWebContents,
  WebContentsView,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from "electron";
import { ElectronChromeExtensions } from "electron-chrome-extensions";
import { installChromeWebStore } from "electron-chrome-web-store";
import { chargeesDans, lireCle, type EtatExtensions, type IdProfil, type MessageConsole, type Portee } from "@webaios/noyau";
import type { EtatNavigateur, IdEspace, IdFenetre } from "../../commun/modele";
import { estInvisible } from "../contenus-invisibles";
import { niveauConsole, type ConsolesExtensions } from "./consoles";
import { connexionNative } from "./natif";
import { hotePermisAgent, idChromeDeDossier, idExtensionDe, urlPermiseAgent } from "./reseau";

/** Canal du preload des correctifs (`src/preload/extensions.ts`) : service workers et pages `chrome-extension://`. */
export const CANAL_DEMARRAGE = "webaios:extension-demarrage";
/**
 * Canaux du garde des extensions de l'agent (`globalThis.__webaios` exposé par le preload des correctifs) : une adresse
 * à ouvrir (`tabs.create`, `tabs.update`, `windows.create`), un onglet où agir (`scripting`, `tabs.insertCSS`), et
 * (synchrone, pages seulement) « cette page est-elle celle d'une extension de l'agent ? ».
 */
export const CANAL_URL_PERMISE = "webaios:extension-url-permise";
export const CANAL_HOTE_PERMIS = "webaios:extension-hote-permis";
export const CANAL_AGENT = "webaios:extension-agent";
/**
 * Canal du garde des extensions de l'agent : « cet id (`sender.tab.id`, celui que la bibliothèque donne aux onglets) est-il
 * une vue d'onglet ? ». La garde de page retient les scripts de contenu tant que la réponse n'est pas oui, et
 * `scripting.executeScript` refuse une autre cible : une lecture invisible n'est jamais un onglet.
 */
export const CANAL_ONGLET = "webaios:extension-onglet";

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

/** Ce qui fait recharger une extension dont le dossier ne change pas : `modifieeLe` (copie de l'agent refaite). */
const marqueDe = (e: EtatExtensions, cle: string): string => e.extensions[cle]?.modifieeLe ?? "";

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
let pagesEcoutees = false;
let protocoleCrx = false;
/** Les instances vivantes : le canal des pages (`ipcMain`, un seul par processus) cherche celle de la session. */
const instancesVivantes = new Set<ExtensionsProfils>();
let canalPagesPose = false;

/** L'id d'extension de la page qui envoie (adresse de son cadre), ou null. */
function idDeLaPage(e: IpcMainEvent | IpcMainInvokeEvent): string | null {
  let url: string | undefined;
  try {
    url = e.senderFrame?.url;
  } catch {
    url = undefined;
  }
  return idExtensionDe(url);
}

/**
 * Comme `idDeLaPage`, mais un cadre `about:blank` / `about:srcdoc` compte pour l'extension dont il a l'origine (celle de
 * la page qui l'a créé).
 */
function idDuCadre(e: IpcMainEvent): string | null {
  const id = idDeLaPage(e);
  if (id) return id;
  try {
    const f = e.senderFrame;
    return f && f.url.startsWith("about:") ? idExtensionDe(f.origin) : null;
  } catch {
    return null;
  }
}

function instanceDeLExpediteur(e: IpcMainInvokeEvent): ExtensionsProfils | undefined {
  for (const x of instancesVivantes) if (x.aLaSession(e.sender.session)) return x;
  return undefined;
}
/** L'extension (chargée dans une session d'une instance vivante) dont `wc` affiche une page, ou null. */
function idPageExtension(wc: WebContents, url: string | undefined): { instance: ExtensionsProfils; id: string } | null {
  const id = idExtensionDe(url);
  if (!id) return null;
  let s: Session;
  try {
    s = wc.session;
  } catch {
    return null;
  }
  for (const instance of instancesVivantes) if (instance.aLaSession(s) && s.extensions.getExtension(id)) return { instance, id };
  return null;
}

/**
 * Dossiers par id d'extension sous `storagePath` d'une session (mesuré avec Electron 45) : `chrome.storage.local` et
 * `.sync` (le même magasin), les autres magasins de réglages, les règles DNR dynamiques. Effacés à la suppression d'une
 * extension de l'agent, une fois `chrome.storage` vidé par l'API (Chromium garde le magasin ouvert après le retrait).
 */
const DOSSIERS_STOCKAGE = ["Local Extension Settings", "Sync Extension Settings", "Managed Extension Settings", "DNR Extension Rules", "Extension Rules"];
/** Vide `chrome.storage` depuis une page de l'extension ; rend le nombre de clés restées dans `local`. */
const VIDER_STOCKAGE = `(async () => {
  for (const zone of ["local", "sync", "session"]) await chrome.storage[zone]?.clear();
  return Object.keys(await chrome.storage.local.get(null)).length;
})()`;

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
  /** Par profil : clé → extension chargée (id Chromium, dossier, `marqueDe` au chargement). */
  private chargees = new Map<IdProfil, Map<string, { id: string; chemin: string; marque: string }>>();
  private erreurs = new Map<string, string>();
  private dernier: EtatExtensions | undefined;
  private file: Promise<void> = Promise.resolve();
  /** Par profil : clé → dossier voulu (posé avant le chargement : un service worker peut démarrer pendant celui-ci). */
  private voulues = new Map<IdProfil, Map<string, string>>();
  /**
   * Ids Chromium des copies de l'agent → clé : calculé depuis le dossier avant chargement (le service worker peut appeler
   * avant que `loadExtension` ne rende), puis celui que Chromium a donné.
   */
  private idsAgent = new Map<string, string>();
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
      /** Note l'id que Chromium a donné à la copie d'une extension de l'agent (`idChrome` du registre). */
      noterIdChrome?(cle: string, id: string): void;
      /** `tabs.create`, `tabs.update`, `windows.create` d'une extension vers `url` ; absent : permis. */
      verifierUrl?(extension: Electron.Extension, url: string): boolean;
      /** `tabs.insertCSS` d'une extension dans un onglet à l'adresse `url` ; absent : permis. */
      verifierHote?(extension: Electron.Extension, url: string): boolean;
      /** Une vue d'onglet de WebAiOs (`vues.ongletDe`) ; absent : aucune vue n'en est un. */
      estOnglet?(wc: WebContents): boolean;
      /**
       * `beforeInstall` de la page du Chrome Web Store dans la session de ce profil (store.ts, `avantInstallation`) ;
       * absent : la page du Store n'est pas équipée.
       */
      avantInstallationStore?(s: Session, profil: IdProfil): (details: { id: string; frame: Electron.WebFrameMain }) => Promise<{ action: "allow" | "deny" }>;
      /**
       * `chrome.management.uninstall` de la page du Store (crochet du correctif), avec le profil de la session qui
       * l'héberge (la bibliothèque choisit le gestionnaire par la session de l'expéditeur IPC) : lève si refusé.
       */
      desinstallerDepuisStore?(id: string, profil: IdProfil): Promise<void>;
      /**
       * Consoles des extensions (service workers et pages `chrome-extension://`) et plantages (pages d'extension disparues
       * hors `clean-exit`, échecs de `loadExtension`), par id Chromium.
       */
      consoles?: Pick<ConsolesExtensions, "noter" | "plantage">;
      /** L'extension `idChrome` va tourner dans une vue d'onglet de `profil`, lisible ou non par l'agent. */
      aTourneDansOnglet?(idChrome: string, profil: IdProfil, lisible: boolean): void;
      /**
       * L'agent peut-il lire cette vue d'onglet (onglet partagé, espace non privé : la règle de ses outils de lecture) ?
       * Absent : jamais (tout ce qui vient d'un onglet lui est masqué).
       */
      lisibleParAgent?(wc: WebContents): boolean;
      /** Après chaque synchronisation des sessions (ce qui est chargé a pu changer : la barre relit). */
      apresSynchro?(): void;
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
      ipcMain.handle(CANAL_URL_PERMISE, (e, url: unknown) => {
        const x = instanceDeLExpediteur(e);
        return !!x && x.urlPermise(e.sender.session, idDeLaPage(e), url);
      });
      ipcMain.handle(CANAL_HOTE_PERMIS, (e, onglet: unknown) => {
        const x = instanceDeLExpediteur(e);
        return !!x && x.hotePermis(e.sender.session, idDeLaPage(e), onglet);
      });
      ipcMain.handle(CANAL_ONGLET, (e, onglet: unknown) => {
        const x = instanceDeLExpediteur(e);
        return !!x && x.estOnglet(e.sender.session, idDeLaPage(e), onglet);
      });
      ipcMain.on(CANAL_AGENT, (e: IpcMainEvent) => {
        const id = idDuCadre(e);
        e.returnValue = !!id && [...instancesVivantes].some((x) => x.accordAgent(id) !== undefined);
      });
    }
    if (o.consoles && !pagesEcoutees) {
      pagesEcoutees = true;
      // Les pages `chrome-extension://` (popups, options, pages ouvertes en onglet) d'une session de profil : leur console
      // et leurs plantages. Un seul écouteur par processus ; l'instance est celle de la session de la page.
      // Les scripts de contenu écrivent dans la console de l'onglet : un message dont la source est un fichier d'une
      // extension chargée dans la session est le sien, noté avec l'onglet d'où il vient (console filtrée de l'agent).
      app.on("web-contents-created", (_e, wc) => {
        wc.on("console-message", (ev) => {
          let url: string | undefined;
          try {
            url = ev.frame?.url ?? wc.getURL();
          } catch {
            url = undefined;
          }
          const m = { horodatage: Date.now(), niveau: niveauConsole(ev.level), texte: String(ev.message) };
          const id = idPageExtension(wc, url);
          if (id) return id.instance.noterConsole(id.id, m);
          const script = idPageExtension(wc, typeof ev.sourceId === "string" ? ev.sourceId : undefined);
          if (script) script.instance.noterConsoleOnglet(script.id, m, wc);
        });
      });
      app.on("render-process-gone", (_e, wc, details) => {
        if (details.reason === "clean-exit") return;
        let url: string | undefined;
        try {
          url = wc.getURL();
        } catch {
          url = undefined;
        }
        const id = idPageExtension(wc, url);
        if (id) id.instance.noterPlantage(id.id, Date.now());
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
      // Une extension de l'agent : seulement ce que son accord permet (reseau.ts) ; puis ce que WebAiOs ajoute.
      verifierUrl: (extension, url) => this.urlPermiseA(extension.id, url) && (this.o.verifierUrl?.(extension, url) ?? true),
      verifierHote: (extension, url) => {
        const accord = this.accordAgent(extension.id);
        if (accord !== undefined && !(accord && hotePermisAgent(url, accord))) return false;
        return this.o.verifierHote?.(extension, url) ?? true;
      },
      connectNative: connexionNative,
    });
    // Après ceux de la bibliothèque : `chrome` y est déjà complété.
    s.registerPreloadScript({ id: "webaios-extensions-fond", type: "service-worker", filePath: this.o.preloadCorrectifs });
    s.registerPreloadScript({ id: "webaios-extensions-page", type: "frame", filePath: this.o.preloadCorrectifs });
    // Comme le routeur de la bibliothèque : les IPC d'un service worker arrivent sur son propre `ipc`.
    // Portée de chaque version démarrée : pendant l'évaluation du script de premier niveau, `getInfoFromVersionID` ne
    // connaît pas encore la version (mesuré), et sa console serait perdue.
    const portees = new Map<number, string>();
    s.serviceWorkers.on("running-status-changed", ({ runningStatus, versionId }) => {
      if (runningStatus !== "starting") return;
      const worker = s.serviceWorkers.getWorkerFromVersionID(versionId);
      if (worker?.scope.startsWith("chrome-extension://")) portees.set(versionId, worker.scope);
      if (!worker || workersEcoutes.has(worker) || !worker.scope.startsWith("chrome-extension://")) return;
      workersEcoutes.add(worker);
      const id = new URL(worker.scope).host;
      worker.ipc.handle(CANAL_DEMARRAGE, () => this.demarrage(profil, s, id, "fond"));
      worker.ipc.handle(CANAL_URL_PERMISE, (_e, url: unknown) => this.urlPermise(s, id, url));
      worker.ipc.handle(CANAL_HOTE_PERMIS, (_e, onglet: unknown) => this.hotePermis(s, id, onglet));
      worker.ipc.handle(CANAL_ONGLET, (_e, onglet: unknown) => this.estOnglet(s, id, onglet));
    });
    // La console des service workers des extensions (portée `chrome-extension://<id>/`).
    s.serviceWorkers.on("console-message", (_e, d) => {
      let scope: string | undefined;
      try {
        scope = s.serviceWorkers.getInfoFromVersionID(d.versionId)?.scope;
      } catch {
        scope = portees.get(d.versionId);
      }
      const id = idExtensionDe(scope);
      if (id) this.o.consoles?.noter(id, { horodatage: Date.now(), niveau: niveauConsole(d.level), texte: String(d.message) });
    });
    // Aucun `session.webRequest` ici : il couperait tout declarativeNetRequest de la session (reseau.ts, branche B).
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
        // Le gestionnaire de cette session : la page du Store qui l'appelle est dans ce profil.
        uninstallHandler: (id) => desinstaller(id, profil),
      }).catch(
        (erreur: unknown) => console.error(`[extensions] page du Store non équipée dans le profil ${profil} :`, erreur),
      );
    }
    if (this.dernier) void this.synchroniser(this.dernier);
  }

  /**
   * Efface le stockage de l'extension dont `chemin` est le dossier (le manifeste sans code posé à la place d'une copie
   * de l'agent supprimée : même id Chromium) dans chacune de `sessions`, dans la file des synchronisations : chargée,
   * `chrome.storage` vidé depuis une de ses pages (jamais montrée), retirée, puis le reste de son origine
   * (`clearStorageData` : IndexedDB, service worker…) et ses dossiers sous `storagePath`. Lève au premier échec.
   */
  effacerStockage(chemin: string, sessions: readonly Session[]): Promise<void> {
    const travail = this.file.then(async () => {
      for (const s of new Set(sessions)) await this.effacerStockageDans(s, chemin);
    });
    this.file = travail.catch(() => undefined);
    return travail;
  }

  private async effacerStockageDans(s: Session, chemin: string): Promise<void> {
    const ext = await s.extensions.loadExtension(chemin, { allowFileAccess: false });
    const id = ext.id;
    try {
      const vue = new WebContentsView({ webPreferences: { session: s, sandbox: true } });
      try {
        await vue.webContents.loadURL(`chrome-extension://${id}/manifest.json`);
        const restees: unknown = await vue.webContents.executeJavaScript(VIDER_STOCKAGE);
        if (restees !== 0) throw new Error(`chrome.storage.local de ${id} non vidé`);
      } finally {
        vue.webContents.close();
      }
    } finally {
      s.extensions.removeExtension(id);
    }
    await s.clearStorageData({ origin: `chrome-extension://${id}` });
    const racine = s.storagePath;
    if (racine) for (const d of DOSSIERS_STOCKAGE) await rm(join(racine, d, id), { recursive: true, force: true });
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

  /**
   * L'accord d'une extension de l'agent par son id Chromium (copie chargée, en cours de chargement, ou notée au
   * registre) ; null : de l'agent, sans accord (ou retirée du registre) ; undefined : pas une extension de l'agent.
   */
  accordAgent(id: string): Portee | null | undefined {
    const e = this.dernier;
    const cle =
      this.idsAgent.get(id) ?? Object.entries(e?.extensions ?? {}).find(([c, x]) => x.idChrome === id && lireCle(c)?.source === "agent")?.[0];
    if (!cle) return undefined;
    return e?.extensions[cle]?.accord ?? null;
  }

  /**
   * `globalThis.__webaios.urlPermise` : une adresse (relative : dans l'extension) que l'extension `id` de cette session
   * peut ouvrir. Une extension du Store : toujours (sa CSP et la bibliothèque décident).
   */
  urlPermise(s: Session, id: string | null, url: unknown): boolean {
    if (!id || typeof url !== "string" || !s.extensions.getExtension(id)) return false;
    return this.urlPermiseA(id, url);
  }

  /** Une adresse (relative : dans l'extension) que l'extension `id` peut ouvrir ; Store : toujours. */
  private urlPermiseA(id: string, url: string): boolean {
    const accord = this.accordAgent(id);
    if (accord === undefined) return true;
    let absolue: string;
    try {
      absolue = new URL(url, `chrome-extension://${id}/`).href;
    } catch {
      return false;
    }
    return !!accord && urlPermiseAgent(absolue, accord, id);
  }

  /** `globalThis.__webaios.hotePermis` : l'onglet `onglet` (id de la bibliothèque) est-il un site des hôtes accordés ? */
  hotePermis(s: Session, id: string | null, onglet: unknown): boolean {
    if (!id || typeof onglet !== "number" || !s.extensions.getExtension(id)) return false;
    const accord = this.accordAgent(id);
    if (accord === undefined) return true;
    const wc = tousLesWebContents.fromId(onglet);
    if (!accord || !wc || wc.isDestroyed() || wc.session !== s) return false;
    return hotePermisAgent(wc.getURL(), accord);
  }

  /**
   * `globalThis.__webaios.estOnglet` : l'id est-il une vue d'onglet (jamais une lecture invisible), dans la session de
   * l'extension `id` qui demande (chargée dans cette session) ?
   */
  estOnglet(s: Session, id: string | null, onglet: unknown): boolean {
    if (!id || typeof onglet !== "number" || !s.extensions.getExtension(id)) return false;
    const wc = tousLesWebContents.fromId(onglet);
    if (!wc || typeof wc.isDestroyed !== "function" || wc.isDestroyed() || wc.session !== s || estInvisible(wc)) return false;
    const vue = this.o.estOnglet?.(wc) ?? false;
    // Ses scripts vont y tourner (poignée de main, executeScript) : noté pour masquer la console de son service worker
    // à l'agent s'il ne peut pas lire cet onglet.
    const profil = [...this.instances].find(([, x]) => x.session === s)?.[0];
    if (vue && profil !== undefined) this.o.aTourneDansOnglet?.(id, profil, this.lisibleParAgent(wc));
    return vue;
  }

  /** Une vue d'onglet (jamais une lecture invisible) que l'agent peut lire. */
  private lisibleParAgent(wc: WebContents): boolean {
    try {
      return !estInvisible(wc) && (this.o.estOnglet?.(wc) ?? false) && (this.o.lisibleParAgent?.(wc) ?? false);
    } catch {
      return false;
    }
  }

  /** La session d'un expéditeur est-elle équipée par cette instance ? */
  aLaSession(s: Session): boolean {
    for (const x of this.instances.values()) if (x.session === s) return true;
    return false;
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
      // Agent : une copie rechargée (même version) est une nouvelle vue, comme le rechargement d'une extension non
      // empaquetée dans Chrome (onInstalled « update », rulesets du manifeste) : la vue porte aussi `modifieeLe`.
      const vue = await this.o.noterVue(cle, profil, agent ? `${ext.version}#${this.dernier?.extensions[cle]?.modifieeLe ?? ""}` : ext.version);
      if (!vue.nouvelle) return vide(agent);
      const { actifs, inactifs } = rulesetsDuManifeste(ext.manifest);
      const precedente = vue.precedente?.split("#")[0];
      return {
        installation: precedente ? { reason: "update", previousVersion: precedente } : { reason: "install" },
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

  /** Un message de la console d'une page de l'extension `id` (écouteur des pages, un par processus). */
  noterConsole(id: string, m: MessageConsole): void {
    this.o.consoles?.noter(id, m);
  }

  /** Un message d'un script de contenu de l'extension `id` dans la vue `wc` (écouteur des pages, un par processus). */
  noterConsoleOnglet(id: string, m: MessageConsole, wc: WebContents): void {
    this.o.consoles?.noter(id, m, { lisible: this.lisibleParAgent(wc) });
  }

  /** Une page de l'extension `id` a planté (écouteur des pages, un par processus). */
  noterPlantage(id: string, horodatage: number): void {
    this.o.consoles?.plantage(id, horodatage);
  }

  /** Les extensions chargées dans la session de ce profil : clé et id Chromium. */
  chargeesProfil(profil: IdProfil): { cle: string; id: string }[] {
    return [...(this.chargees.get(profil) ?? [])].map(([cle, c]) => ({ cle, id: c.id }));
  }

  /** La clé d'une copie de l'agent par son id Chromium (chargée, ou en cours de chargement), ou undefined. */
  cleAgent(id: string): string | undefined {
    return this.idsAgent.get(id);
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
    this.o.apresSynchro?.();
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
      // Même dossier et même marque : rien à faire. Une copie de l'agent refaite (même dossier) a une nouvelle marque.
      if (voulues.get(cle) === c.chemin && marqueDe(e, cle) === c.marque) continue;
      this.retirer(s, profil, cle, c.id);
      chargees.delete(cle);
    }
    for (const [cle, chemin] of voulues) {
      if (chargees.has(cle)) continue;
      if (lireCle(cle)?.source === "agent") this.idsAgent.set(idChromeDeDossier(chemin), cle);
      try {
        const ext = await s.extensions.loadExtension(chemin, { allowFileAccess: false });
        this.erreurs.delete(cle);
        // Le profil est devenu privé pendant le chargement : une extension de l'agent repart aussitôt.
        if (lireCle(cle)?.source === "agent" && profilPrive(this.o.etat(), profil)) {
          this.retirer(s, profil, cle, ext.id);
          continue;
        }
        chargees.set(cle, { id: ext.id, chemin, marque: marqueDe(e, cle) });
        if (lireCle(cle)?.source === "agent") this.idsAgent.set(ext.id, cle);
        if (lireCle(cle)?.source === "agent" && e.extensions[cle]?.idChrome !== ext.id) this.o.noterIdChrome?.(cle, ext.id);
        // Rien n'assure qu'un service worker MV3 démarre au chargement : ses règles et son onInstalled en dépendent.
        if ((ext.manifest as { background?: unknown }).background) {
          await s.serviceWorkers.startWorkerForScope(ext.url).catch((erreur: unknown) => console.error(`[extensions] fond de ${cle} non démarré :`, erreur));
        }
      } catch (erreur) {
        this.erreurs.set(cle, (erreur as Error).message);
        console.error(`[extensions] ${cle} non chargée dans le profil ${profil} :`, erreur);
        // Un échec de chargement compte comme un plantage : trois en une minute, et elle est désactivée.
        const lue = lireCle(cle);
        if (lue) this.o.consoles?.plantage(lue.source === "store" ? lue.id : idChromeDeDossier(chemin), Date.now());
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
