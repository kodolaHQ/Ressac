import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebContents } from "electron";
import {
  activer,
  analyserManifeste,
  appliquerProfilsPrives,
  chargeesDans,
  couperTout,
  desactiver,
  desactiverPartout,
  epingler,
  libellesPortee,
  ERREUR_PROFIL_PRIVE,
  empreintePortee,
  lireCle,
  lireEtatExtensions,
  modifierEtatExtensions,
  preparerStore,
  retirerProfil,
  RESERVE_AGENT,
  DEMANDE_RETIREE,
  type ConsolePourAgent,
  type ExtensionPourAgent,
  type EtatExtensions,
  type IdProfil,
  type OutilsExtensions,
  type ResultatConsoleExtension,
  type ResultatDemandeExtension,
} from "@webaios/noyau";
import {
  carteDe,
  DESACTIVEE_PLANTAGES,
  DESACTIVEE_PORTEE,
  LONGUEUR_RAISON_DEBLOCAGE,
  nonPrisEnCharge,
  type BarreExtensions,
  type CarteExtension,
  type LigneExtension,
  type LigneExtensionEspace,
  type ReponseAccord,
} from "../../commun/extensions";
import type { ResultatExtension } from "../../commun/api";
export { DESACTIVEE_PLANTAGES, DESACTIVEE_PORTEE };
import { aUneVue, partitionDe, profilsEnUsage, type Demande, type Issue, type Espace, type EtatNavigateur, type IdFenetre } from "../../commun/modele";
import { attendreIssue, DELAI_QUESTION_MS, questionCaduque } from "../agent/pont";
import type { Magasin } from "../ipc";
import type { GestionnaireVues } from "../onglets/vues";
import type { SessionsProfils } from "../profils-connexion";
import {
  ACTIVATION_REFUSEE,
  ACTIVATION_RETIREE,
  demanderActivation,
  demarrerAgents,
  preparerAgent,
  TOUTES_COUPEES_AGENT,
  recharger,
  supprimerAgent,
  type DependancesAgent,
  type PreparationAgent,
  type ResultatActivation,
  type ResultatRechargement,
} from "./agent";
import { ConsolesExtensions, type FiltreAgent } from "./consoles";
import { idChromeDeDossier } from "./reseau";
import { profilPrive, type CibleOnglet, type ExtensionsProfils } from "./sessions";
import {
  abandonnerMiseAJour,
  accepterMiseAJour,
  appliquerMiseAJour,
  chercherMisesAJour,
  INTERVALLE_MAJ_MS,
  PREMIERE_MAJ_MS,
  type DependancesMiseAJour,
  type ResultatMiseAJour,
} from "./mises-a-jour";
import {
  accordPour,
  desinstallerStore,
  enFileStore,
  fileStoreOccupee,
  installerStore,
  lireManifeste,
  retirerDuProfilStore,
  type ContexteInstallation,
  type DependancesStore,
  type ResultatStore,
} from "./store";

/**
 * Pose une question dans une fenêtre (`poserQuestion` d'index.ts) : `fenetreId` absent, celle de l'agent (la fenêtre au
 * premier plan, ou la dernière utilisée). Rend de quoi la retirer.
 */
export type PoserQuestion = (champs: Omit<Demande, "ongletId">, repondre: (d: Issue) => void) => () => void;

/** Une carte affichée : `attentes` demandes l'attendent ; `connue` : l'extension était dans le registre à sa pose. */
interface CarteOuverte {
  cle: string;
  reponse: Promise<Issue>;
  retrait: AbortController;
  connue: boolean;
  attentes: number;
  /** Posée pendant la coupure générale par un clic de l'utilisateur (installation du Store) : la coupure ne la fait pas tomber. */
  pendantCoupure: boolean;
}

/** Deux demandes partagent une carte seulement si ce qu'elle montre est le même : clé, espace, mise à jour, renforcé, portée. */
const signatureCarte = (c: CarteExtension) => JSON.stringify([c.cle, c.espaceId, c.maj?.de ?? null, c.renforce, c.empreinte]);

/** Les profils de connexion utilisés par au moins un espace privé. */
export function profilsPrives(etat: EtatNavigateur): Set<IdProfil> {
  return new Set(etat.espaces.filter((e) => e.prive).map((e) => e.profil));
}

/**
 * `ouvrirOnglet` d'`ExtensionsProfils` : l'onglet est ouvert dans la fenêtre et l'espace choisis, et sa vue créée tout
 * de suite (même en arrière-plan) pour que l'extension la reçoive.
 */
export function ouvrirOngletPourExtension(magasin: Magasin, vues: GestionnaireVues) {
  return async (cible: CibleOnglet, url: string, actif: boolean): Promise<WebContents | null> => {
    if (!aUneVue(url)) return null;
    const avant = new Set(Object.keys(magasin.etat.onglets));
    magasin.agir({ type: "ouvrirOnglet", fenetreId: cible.fenetreId, espaceId: cible.espaceId, url, activer: actif });
    const nouveau = Object.values(magasin.etat.onglets).find((o) => !avant.has(o.id));
    return nouveau ? (vues.vue(nouveau.id) ?? vues.preparerVue(nouveau)) : null;
  };
}

const SANS_DOSSIER_AGENT = "Pas de dossier pour les extensions de l'agent";
/** « Revoir » pendant la coupure générale : aucune carte n'est montrée, la mise à jour (ou l'accord) attend. */
export const REVOIR_PENDANT_COUPURE = "Les extensions sont toutes désactivées : réactive-les pour revoir cette extension";
export const RIEN_A_REVOIR = "Rien à revoir pour cette extension";
/** Erreurs de console montrées sur la page Extensions, au plus (les dernières). */
const ERREURS_CONSOLE_PAGE = 20;
/** Déblocage de la console refusé : l'extension tourne dans le profil d'un espace privé (impossible par construction). */
export const CONSOLE_PROFIL_PRIVE = "Extension active dans le profil d'un espace privé : sa console n'est jamais montrée à l'agent";
export const DEBLOCAGE_INACTIVE = "Extension inactive ou désactivée : rien à débloquer (demande d'abord son activation)";
export const DEBLOCAGE_CHANGE = "L'extension a changé pendant la carte : rien n'est débloqué";
/**
 * Droits qui font voir à une extension les onglets ou la navigation (adresses, titres, cookies, historique…), même sans
 * y tourner, ce que l'utilisateur y copie (`clipboardRead`), ce qu'il y sélectionne et clique (`contextMenus` : la sélection et
 * les adresses de la page arrivent avec le clic) ou les requêtes de ses onglets touchées par ses règles
 * (`declarativeNetRequestFeedback`) : avec l'un d'eux, des hôtes ou tous les sites, la console de son
 * service worker et de ses pages est toujours masquée à l'agent (sauf déblocage). Ce qu'elle observe peut être gardé et
 * écrit plus tard : la décision ne dépend pas des onglets ouverts au moment du message.
 */
export const DROITS_OBSERVATEURS = ["tabs", "webNavigation", "cookies", "history", "topSites", "sessions", "bookmarks", "activeTab", "clipboardRead", "contextMenus",
  "declarativeNetRequestFeedback"];

/** Ce que l'utilisateur a vu sur la carte de déblocage : le déblocage ne vaut que pour cela. */
interface LienDeblocage {
  idChrome: string | null;
  /** Les profils où elle était active : l'activer dans un autre y met fin. */
  profils: IdProfil[];
  /** `modifieeLe` : une nouvelle copie (rechargée, recréée) y met fin. */
  marque: string | null;
}

/**
 * La clé `agent:<dossier>` d'un id donné par l'agent (`<dossier>` ou `agent:<dossier>`). Toute autre clé (Store) lève
 * `RESERVE_AGENT` : deuxième barrière derrière les outils du noyau. Un id illisible rend null.
 */
function cleAgentPour(id: string): string | null {
  if (id.includes(":") && !id.startsWith("agent:")) throw new Error(RESERVE_AGENT);
  const cle = id.startsWith("agent:") ? id : `agent:${id}`;
  return lireCle(cle)?.source === "agent" ? cle : null;
}

/**
 * Relie le registre des extensions (`<userData>/extensions/etat.json`) aux sessions des profils : au démarrage, il lit
 * le registre, prépare les extensions du Store et charge ce qui est actif ; ensuite, après chaque modification du
 * registre et chaque changement des profils ou de leur caractère privé. Les tâches suivantes y ajoutent leurs méthodes.
 */
export class ServiceExtensions {
  private etat: EtatExtensions = { version: 1, toutesCoupees: false, extensions: {} };
  /** Erreurs de préparation (Store), par clé ; celles du chargement sont dans `ExtensionsProfils`. */
  private erreursPreparation = new Map<string, string>();
  /** Erreur de la dernière mise à jour du Store, par clé (en mémoire : vide au démarrage, jusqu'à la prochaine vérification). */
  private erreursMaj = new Map<string, string>();
  /**
   * Versions préparées par une mise à jour, par clé : leur réussite n'efface l'erreur de préparation de la clé que quand
   * le registre en fait la version installée (une version en attente n'est jamais chargée).
   */
  private prepareesMaj = new Map<string, string>();
  /** Erreurs des extensions de l'agent (préparation de la copie, dossier absent), par clé, en mémoire. */
  private erreursAgent = new Map<string, string>();
  /** Extensions de l'agent qui ne sont plus chargées tant que leur erreur reste (dossier absent). */
  private agentsBloques = new Set<string>();
  /** Faux jusqu'à la fin de `demarrerAgents` : `appliquer` laisse alors de côté les extensions de l'agent. */
  private agentsPrets = false;
  /** La vérification des mises à jour en cours : une seule à la fois. */
  private verification: Promise<void> | null = null;
  /** Profils effacés avant le démarrage du service : retirés du registre dès qu'il est prêt. */
  private profilsARetirer: IdProfil[] = [];
  /** Registre lu et Store préparé : les synchronisations peuvent commencer. */
  private pret = false;
  private poser: PoserQuestion | undefined;
  /** Les cartes d'accord affichées, par clé. `connue` : l'extension était dans le registre quand la carte a été posée. */
  private cartes = new Map<string /* signatureCarte */, CarteOuverte>();
  /**
   * Extensions de l'agent dont l'utilisateur a débloqué la console pour l'agent : en mémoire seulement (quitter WebAiOs y met
   * fin), retirées par `refermerConsole`, et à chaque écriture du registre qui la retire, la désactive ou la coupe.
   */
  private deblocages = new Map<string, LienDeblocage>();
  /** Cartes de déblocage affichées, par clé : une seule à la fois, retirée si l'extension part du registre ou change. */
  private cartesDeblocage = new Map<string, { reponse: Promise<Issue>; retrait: AbortController; lien: LienDeblocage; attentes: number }>();
  /** Écritures de `consoleMasquee` en cours, par `clé|profil` : une seule à la fois. */
  private masquagesEnCours = new Map<string, Promise<void>>();
  /**
   * Consoles et plantages des extensions (branchés par `ExtensionsProfils`) : au `PLANTAGES_MAX`-ième plantage en
   * `FENETRE_PLANTAGES_MS`, l'extension est désactivée partout (`DESACTIVEE_PLANTAGES`).
   */
  readonly consoles = new ConsolesExtensions({
    surPlantages: (id) => void this.desactiverPlantages(id).catch((e: unknown) => console.error(`[extensions] ${id} non désactivée après ses plantages :`, e)),
  });
  private o:
    | {
        dossier: string;
        profils: ExtensionsProfils;
        sessions: SessionsProfils;
        vues: GestionnaireVues;
        magasin: Magasin;
        dossierGardes: string;
        dossierAgent?: string;
        surChange?: () => void;
      }
    | undefined;

  async demarrer(o: {
    /** `<userData>/extensions`. */
    dossier: string;
    profils: ExtensionsProfils;
    sessions: SessionsProfils;
    vues: GestionnaireVues;
    magasin: Magasin;
    /** Les gardes et correctifs livrés (`packages/noyau/extensions`). */
    dossierGardes: string;
    /**
     * `~/WebAiOs/extensions` (ce qu'écrit l'agent) : au démarrage, chaque extension de l'agent accordée y est recopiée
     * (`demarrerAgents`). Absent : les copies en place sont chargées telles quelles.
     */
    dossierAgent?: string;
    /** Après chaque écriture du registre (`CANAUX.extensionsChange`). */
    surChange?: () => void;
  }): Promise<void> {
    this.o = o;
    // Posé d'abord, de façon synchrone : il existe même si la lecture du registre échoue, et index.ts appelle `demarrer`
    // avant d'abonner les vues, donc il passe avant elles. Un espace devenu privé, ou un profil apparu ou disparu :
    // ce qui est chargé dans chaque profil change.
    let prives = [...profilsPrives(o.magasin.etat)].sort().join("|");
    let enUsage = [...profilsEnUsage(o.magasin.etat)].sort().join("|");
    o.magasin.abonner((etat) => {
      const p = [...profilsPrives(etat)].sort().join("|");
      const u = [...profilsEnUsage(etat)].sort().join("|");
      if (p === prives && u === enUsage) return;
      const devenusPrives = p !== prives;
      prives = p;
      enUsage = u;
      // Tout de suite, hors de la file : aucune page d'un espace privé ne se charge avec une extension de l'agent.
      o.profils.retirerAgentsPrives(etat);
      if (!this.pret) return;
      // Les profils privés changent (espace créé ou réglé, d'où que vienne l'action) : le registre est réécrit, et
      // `modifierEtatExtensions` y retire les extensions de l'agent des profils privés (évalués dans l'écriture, sans
      // comparer avec un état du registre peut-être en retard). Il resynchronise les sessions ; sinon, seulement elles.
      if (devenusPrives) void this.modifier((e) => e).catch((e: unknown) => console.error("[extensions] profils privés non appliqués :", e));
      else void this.appliquer();
    });
    try {
      this.etat = await lireEtatExtensions(o.dossier);
    } catch (e) {
      // Registre illisible (droits, disque) : aucune extension chargée, jamais un plantage au démarrage.
      console.error("[extensions] registre illisible, aucune extension chargée :", e);
      return;
    }
    await this.preparerStore();
    if (o.dossierAgent) {
      // Les extensions du Store d'abord (les copies de l'agent peuvent être longues à refaire), sans celles de l'agent...
      await this.appliquer();
      // ... puis chaque copie de l'agent est refaite depuis son dossier (ou déchargée, ou désactivée).
      const d = this.dependancesAgent();
      if (d) await demarrerAgents(d);
    }
    this.agentsPrets = true;
    this.pret = true;
    // Un état écrit avant ce démarrage (session éditée, profil effacé au lancement) : le registre est remis d'aplomb.
    const aRetirer = this.profilsARetirer.splice(0);
    if (aRetirer.length > 0 || appliquerProfilsPrives(this.etat, profilsPrives(o.magasin.etat)).retirees.length > 0)
      await this.modifier((e) => aRetirer.reduce(retirerProfil, e));
    else await this.appliquer();
    // Repère des tests (mode invisible) : le démarrage est fini, la première synchronisation complète faite.
    if (process.env.WEBAIOS_INVISIBLE === "1") (globalThis as { __webaiosExtensionsPretes?: boolean }).__webaiosExtensionsPretes = true;
  }

  /**
   * Un profil de connexion a été effacé : il quitte toutes les extensions (profils actifs, versions vues). Avant le
   * démarrage du service, noté pour après la lecture du registre.
   */
  async retirerProfil(profil: IdProfil): Promise<void> {
    if (!this.o || !this.pret) {
      this.profilsARetirer.push(profil);
      return;
    }
    await this.modifier((e) => retirerProfil(e, profil));
  }

  /** Modifie le registre (profils privés évalués dans l'écriture), puis recharge les sessions. */
  async modifier(changer: (e: EtatExtensions, profilsPrives: ReadonlySet<IdProfil>) => EtatExtensions): Promise<EtatExtensions> {
    const o = this.o;
    if (!o) throw new Error("Service des extensions non démarré");
    this.etat = await modifierEtatExtensions(o.dossier, changer, () => profilsPrives(o.magasin.etat));
    this.perimerCartes();
    this.verifierDeblocages();
    // Pendant le démarrage (extensions de l'agent recopiées), le premier chargement vient ensuite.
    if (this.pret) await this.appliquer();
    o.surChange?.();
    return this.etat;
  }

  /**
   * Note la version démarrée d'une extension dans un profil (`vues[profil]`, pour `onInstalled` et les rulesets du
   * manifeste). Lu et écrit dans la même modification sérialisée : deux démarrages simultanés n'ont qu'une seule
   * « première fois ». Les sessions ne sont pas resynchronisées (les vues ne changent pas ce qui est chargé).
   *
   * Invariant (avec `noterIdChrome`, `masquerId`, `aTourneDansOnglet`) : ces écritures passent par
   * `modifierEtatExtensions` sans `perimerCartes` ni `verifierDeblocages`, parce qu'elles ne touchent aucun champ dont
   * dépend une carte ou un déblocage (`accord`, `profils`, `modifieeLe`, `desactivee` ; `idChrome` se déduit du chemin
   * de la copie et ne change donc pas). Une écriture qui toucherait l'un d'eux doit passer par `modifier`.
   */
  async noterVue(cle: string, profil: IdProfil, version: string): Promise<{ nouvelle: boolean; precedente?: string }> {
    const o = this.o;
    if (!o) throw new Error("Service des extensions non démarré");
    // Un service worker MV3 redémarre à chaque réveil : le cas courant (déjà vue) n'écrit rien. `this.etat` suit chaque
    // écriture du service, seul à écrire le registre pendant que l'application tourne.
    const connue = this.etat.extensions[cle];
    if (!connue || connue.vues[profil] === version) return { nouvelle: false };
    // Un service worker qui démarre après le retrait de son profil ne remet pas une vue pour ce profil.
    const enUsage = () => profilsEnUsage(o.magasin.etat).has(profil);
    if (!enUsage()) return { nouvelle: false };
    let resultat: { nouvelle: boolean; precedente?: string } = { nouvelle: false };
    this.etat = await modifierEtatExtensions(
      o.dossier,
      (e) => {
        const x = e.extensions[cle];
        const precedente = x?.vues[profil];
        if (!x || precedente === version || !enUsage()) return e;
        resultat = precedente ? { nouvelle: true, precedente } : { nouvelle: true };
        return { ...e, extensions: { ...e.extensions, [cle]: { ...x, vues: { ...x.vues, [profil]: version } } } };
      },
      () => profilsPrives(o.magasin.etat),
    );
    if (resultat.nouvelle) o.surChange?.();
    return resultat;
  }

  /**
   * Branche les questions des fenêtres (après leur création). `carteTest` (e2e, `WEBAIOS_TEST_CARTE_EXTENSION`) : chemin
   * d'un JSON `CarteExtension` posé tout de suite, sans délai ; la réponse est notée dans `<carteTest>.reponse`.
   */
  brancherQuestions(poser: PoserQuestion, o: { carteTest?: string } = {}): void {
    this.poser = poser;
    const chemin = o.carteTest;
    if (!chemin) return;
    void (async () => {
      try {
        const carte = JSON.parse(await readFile(chemin, "utf8")) as CarteExtension;
        const { accepte } = await this.demanderAccord(carte, {});
        await writeFile(`${chemin}.reponse`, String(accepte));
      } catch (e) {
        console.error("[extensions] carte de test :", e);
      }
    })();
  }

  /**
   * La carte d'accord : `accepte` si l'utilisateur clique « Activer » ; `empreinte` est celle de la portée montrée, que
   * l'appelant compare à `empreintePortee` de la portée qu'il va écrire (différente : il n'écrit rien). Sans `delaiMs`
   * (demande venue d'un clic de l'utilisateur), elle attend ; l'agent passe `DELAI_QUESTION_MS`, au bout duquel elle tombe et
   * vaut refus, comme un `signal` levé. Refus aussi : questions pas encore branchées, extensions toutes coupées, carte
   * déjà caduque ; et, carte affichée, l'extension retirée du registre, la coupure générale, la carte caduque
   * (`questionCaduque`), sa fenêtre fermée sans autre fenêtre (index.ts). Une demande identique (`signatureCarte`) rejoint
   * la carte affichée ; elle garde son délai et son signal, qui ne refusent qu'elle.
   */
  demanderAccord(
    c: CarteExtension,
    o: { fenetre?: IdFenetre; delaiMs?: number; signal?: AbortSignal; pendantCoupure?: boolean },
  ): Promise<ReponseAccord> {
    // Aucune carte montrée, ou tombée sans réponse de l'utilisateur : « retirée », jamais un refus de sa part.
    const refus: ReponseAccord = { accepte: false, empreinte: c.empreinte, retiree: true };
    if (o.signal?.aborted) return Promise.resolve(refus);
    const coupee = this.etat.toutesCoupees && o.pendantCoupure !== true;
    // Une carte identique déjà affichée : la demande la rejoint (même réponse). Sinon, une carte à part, en file comme
    // les autres questions.
    const signature = signatureCarte(c);
    let carte = this.cartes.get(signature);
    if (carte && coupee) return Promise.resolve(refus);
    if (!carte) {
      const poser = this.poser;
      if (!poser || coupee) return Promise.resolve(refus);
      const demande = { permissions: ["extension" as const], origine: c.cle, extension: c, ...(o.fenetre ? { fenetreId: o.fenetre } : {}) };
      // Déjà caduque (espace disparu, profil privé pour l'agent) : pas de carte.
      if (this.o && questionCaduque({ ...demande, id: "", ongletId: null }, this.o.magasin.etat)) return Promise.resolve(refus);
      const retrait = new AbortController();
      const ouverte: CarteOuverte = {
        cle: c.cle,
        reponse: Promise.resolve<Issue>("retiree"),
        retrait,
        connue: c.cle in this.etat.extensions,
        attentes: 0,
        pendantCoupure: o.pendantCoupure === true,
      };
      // La carte elle-même n'a pas de délai : chaque demande a le sien (ci-dessous). Elle tombe quand plus personne ne
      // l'attend, ou par `perimerCartes`.
      ouverte.reponse = attendreIssue((repondre) => poser(demande, repondre), Infinity, retrait.signal).finally(() => {
        if (this.cartes.get(signature) === ouverte) this.cartes.delete(signature);
      });
      this.cartes.set(signature, ouverte);
      carte = ouverte;
    }
    return this.attendreCarte(signature, carte, c.empreinte, o);
  }

  /** Une demande attend la carte : son délai ou son signal ne la refusent qu'elle ; la dernière partie retire la carte. */
  private attendreCarte(signature: string, carte: CarteOuverte, empreinte: string, o: { delaiMs?: number; signal?: AbortSignal }): Promise<ReponseAccord> {
    carte.attentes++;
    return new Promise((ok) => {
      let finie = false;
      const finir = (issue: Issue) => {
        if (finie) return;
        finie = true;
        clearTimeout(minuterie);
        o.signal?.removeEventListener("abort", partir);
        ok({ accepte: issue === "autoriser", empreinte, ...(issue === "retiree" ? { retiree: true } : {}) });
      };
      const partir = () => {
        if (finie) return;
        finir("retiree");
        if (--carte.attentes === 0) {
          // Retirée de la table tout de suite : une nouvelle demande pose une nouvelle carte, elle ne rejoint pas celle-ci.
          if (this.cartes.get(signature) === carte) this.cartes.delete(signature);
          carte.retrait.abort();
        }
      };
      const minuterie = o.delaiMs !== undefined && Number.isFinite(o.delaiMs) ? setTimeout(partir, o.delaiMs) : undefined;
      o.signal?.addEventListener("abort", partir, { once: true });
      void carte.reponse.then(finir);
    });
  }

  /** Après chaque écriture du registre : les cartes d'une extension retirée, ou toutes si tout est coupé, tombent. */
  private perimerCartes(): void {
    for (const [signature, carte] of this.cartes)
      if ((this.etat.toutesCoupees && !carte.pendantCoupure) || (carte.connue && !(carte.cle in this.etat.extensions))) {
        this.cartes.delete(signature);
        carte.retrait.abort();
      }
  }

  /** Installe une extension du Store (voir `installerStore` de store.ts) : la carte, puis le registre et les sessions. */
  installerStore(id: string, c: ContexteInstallation): Promise<ResultatStore> {
    if (!this.o) return Promise.resolve({ ok: false, erreur: "Service des extensions non démarré" });
    return installerStore(id, c, this.dependancesStore());
  }

  /**
   * « Retirer de Chrome » sur la page du Store hébergée dans la session de `profil` : seulement une extension du Store
   * inscrite (une extension de l'agent a un autre id) et active dans ce profil ; retirée de ce profil seulement, et
   * désinstallée (fichiers, entrée) quand aucun autre profil ne la garde.
   */
  desinstallerDepuisStore(id: string, profil: IdProfil): Promise<void> {
    const cle = /^[a-p]{32}$/.test(id) ? `store:${id}` : null;
    if (!cle || !(cle in this.etat.extensions)) return Promise.reject(new Error(`Extension du Store inconnue : ${id}`));
    if (!this.o) return Promise.reject(new Error("Service des extensions non démarré"));
    return retirerDuProfilStore(cle, profil, this.dependancesStore()).then(() => this.oublierMaj(cle));
  }

  /** Prépare la copie d'attente d'une extension de l'agent (voir `preparerAgent` d'agent.ts). */
  preparerAgent(id: string): Promise<PreparationAgent> {
    const d = this.dependancesAgent();
    return Promise.resolve(d ? preparerAgent(id, d) : { ok: false as const, refus: [SANS_DOSSIER_AGENT] });
  }

  /** L'agent demande d'activer son extension `id` dans un espace : la carte de la copie préparée (agent.ts). */
  demanderActivation(id: string, o: { espace: Espace; fenetre?: IdFenetre; delaiMs?: number; signal?: AbortSignal }): Promise<ResultatActivation> {
    if (!this.o || !this.pret) return Promise.resolve({ ok: false, erreur: "Service des extensions non démarré" });
    const d = this.dependancesAgent();
    return d ? demanderActivation(id, o, d) : Promise.resolve({ ok: false, erreur: SANS_DOSSIER_AGENT });
  }

  /**
   * La section « Extensions » des réglages de `espaceId` : les extensions du registre et les dossiers de l'agent jamais
   * accordés, vus depuis le profil de cet espace.
   */
  async pourEspace(espaceId: string): Promise<LigneExtensionEspace[]> {
    const o = this.o;
    const nav = o?.magasin.etat;
    const espace = nav?.espaces.find((e) => e.id === espaceId);
    if (!o || !nav || !espace) return [];
    const autres = nav.espaces.filter((e) => e.id !== espace.id && e.profil === espace.profil).map((e) => e.nom);
    const prive = profilPrive(nav, espace.profil);
    const lignes: LigneExtensionEspace[] = Object.entries(this.etat.extensions).map(([cle, x]) => {
      const active = x.profils.includes(espace.profil);
      return {
        cle,
        nom: x.nom,
        source: x.source,
        active,
        aussiDans: active ? autres : [],
        grisee: x.source === "agent" && prive ? ERREUR_PROFIL_PRIVE : null,
        profils: [...x.profils],
      };
    });
    // Les dossiers que l'agent a écrits et que l'utilisateur n'a jamais accordés : seuls leurs noms, jamais leur contenu.
    if (o.dossierAgent) {
      const noms = await readdir(o.dossierAgent, { withFileTypes: true }).catch(() => []);
      for (const d of noms) {
        const cle = `agent:${d.name}`;
        if (!d.isDirectory() || lireCle(cle) === null || cle in this.etat.extensions) continue;
        lignes.push({ cle, nom: d.name, source: "agent", active: false, aussiDans: [], grisee: prive ? ERREUR_PROFIL_PRIVE : null, profils: [] });
      }
    }
    return lignes.sort((a, b) => a.nom.localeCompare(b.nom) || a.cle.localeCompare(b.cle));
  }

  /**
   * L'interrupteur d'une extension dans les réglages de `espaceId`. Désactiver et activer une extension du Store déjà
   * accordée : tout de suite. Une extension de l'agent sans accord (ou désactivée pour une portée élargie) passe par sa
   * carte (`demanderActivation`) ; dans un profil privé, elle est refusée.
   */
  async basculer(cle: string, espaceId: string, actif: boolean, fenetre?: IdFenetre): Promise<ResultatStore> {
    const o = this.o;
    const lue = lireCle(cle);
    const espace = o?.magasin.etat.espaces.find((e) => e.id === espaceId);
    if (!o || !this.pret || !lue) return { ok: false, erreur: "Service des extensions non démarré" };
    if (!espace) return { ok: false, erreur: "Espace inconnu" };
    const profil = espace.profil;
    const ecrire = async (changer: (e: EtatExtensions, prives: ReadonlySet<IdProfil>) => EtatExtensions): Promise<ResultatStore> => {
      try {
        await (lue.source === "store" ? enFileStore(o.dossier, lue.id, () => this.modifier(changer)) : this.modifier(changer));
        return { ok: true };
      } catch (e) {
        return { ok: false, erreur: (e as Error).message };
      }
    };
    if (!actif) return ecrire((e) => (cle in e.extensions ? desactiver(e, cle, profil) : e));
    if (lue.source === "agent" && profilPrive(o.magasin.etat, profil)) return { ok: false, erreur: ERREUR_PROFIL_PRIVE };
    if (this.etat.toutesCoupees) return { ok: false, erreur: TOUTES_COUPEES_AGENT };
    const x = this.etat.extensions[cle];
    if (lue.source === "agent" && !(x?.accord && x.desactivee === null)) {
      return this.demanderActivation(lue.id, { espace, ...(fenetre ? { fenetre } : {}) });
    }
    if (!x) return { ok: false, erreur: `Extension inconnue : ${cle}` };
    if (x.desactivee) return { ok: false, erreur: x.desactivee.raison === "plantages" ? DESACTIVEE_PLANTAGES : DESACTIVEE_PORTEE };
    // Revérifié dans l'écriture sérialisée : la coupure générale ou une désactivation ont pu arriver entre-temps.
    return ecrire((e, prives) => {
      if (e.toutesCoupees) throw new Error(TOUTES_COUPEES_AGENT);
      const d = e.extensions[cle]?.desactivee;
      if (d) throw new Error(d.raison === "plantages" ? DESACTIVEE_PLANTAGES : DESACTIVEE_PORTEE);
      return activer(e, cle, profil, prives);
    });
  }

  /** Recharge l'extension de l'agent `id` depuis son dossier, sans carte si sa portée reste dans l'accord (agent.ts). */
  recharger(id: string): Promise<ResultatRechargement> {
    if (!this.o || !this.pret) return Promise.resolve({ etat: "refusee", detail: ["Service des extensions non démarré"] });
    const d = this.dependancesAgent();
    return d ? recharger(id, d) : Promise.resolve({ etat: "refusee", detail: [SANS_DOSSIER_AGENT] });
  }

  /** Null sans dossier de l'agent (les appelants rendent un refus). */
  private dependancesAgent(): DependancesAgent | null {
    const o = this.o;
    if (!o?.dossierAgent) return null;
    return {
      dossier: o.dossier,
      dossierAgent: o.dossierAgent,
      dossierGardes: o.dossierGardes,
      etatNavigateur: () => o.magasin.etat,
      etatExtensions: () => this.etat,
      modifier: (changer) => this.modifier(changer),
      demanderAccord: (c, x) => this.demanderAccord(c, x),
      noterErreur: async (cle, erreur, bloquee = false) => {
        const avant = this.agentsBloques.has(cle);
        if (erreur === null) this.erreursAgent.delete(cle);
        else this.erreursAgent.set(cle, erreur);
        if (erreur !== null && bloquee) this.agentsBloques.add(cle);
        else this.agentsBloques.delete(cle);
        if (avant !== this.agentsBloques.has(cle) && this.pret) await this.appliquer();
        o.surChange?.();
      },
      effacerStockage: (chemin) => this.effacerStockage(chemin),
    };
  }

  /**
   * Efface le stockage de l'extension dont `chemin` est la copie (vidée, `MANIFESTE_EFFACEMENT` à sa place) dans la
   * session de chaque profil connu, privés compris. En échec, son id Chromium est gardé au registre (`consolesMasquees`) :
   * recréée au même endroit, sa console reste masquée à l'agent.
   */
  private async effacerStockage(chemin: string): Promise<void> {
    const o = this.o;
    if (!o) return;
    const idChrome = idChromeDeDossier(chemin);
    try {
      if (!o.profils.effacerStockage) throw new Error("effacement du stockage non branché");
      const profils = [...new Set([...o.magasin.etat.profils.map((p) => p.id), ...profilsEnUsage(o.magasin.etat)])];
      await o.profils.effacerStockage(chemin, profils.map((p) => o.sessions.session(p)));
    } catch (e) {
      console.error(`[extensions] stockage de ${idChrome} non effacé (sa console reste masquée à l'agent) :`, e);
      await this.masquerId(idChrome);
    }
  }

  /** Garde `idChrome` dans `consolesMasquees` (jamais retiré). */
  private async masquerId(idChrome: string): Promise<void> {
    const o = this.o;
    if (!o || this.etat.consolesMasquees?.includes(idChrome)) return;
    this.etat = await modifierEtatExtensions(
      o.dossier,
      (e) => (e.consolesMasquees?.includes(idChrome) ? e : { ...e, consolesMasquees: [...(e.consolesMasquees ?? []), idChrome] }),
      () => profilsPrives(o.magasin.etat),
    );
    o.surChange?.();
  }

  /**
   * Note l'id que Chromium a donné à la copie d'une extension de l'agent (`idChrome`), sans resynchroniser les sessions.
   */
  async noterIdChrome(cle: string, id: string): Promise<void> {
    const o = this.o;
    if (!o || this.etat.extensions[cle]?.idChrome === id) return;
    this.etat = await modifierEtatExtensions(
      o.dossier,
      (e) => {
        const x = e.extensions[cle];
        return !x || x.source !== "agent" || x.idChrome === id ? e : { ...e, extensions: { ...e.extensions, [cle]: { ...x, idChrome: id } } };
      },
      () => profilsPrives(o.magasin.etat),
    );
    o.surChange?.();
  }

  /** Retire une extension de toutes les sessions et du registre, et efface son dossier (et oublie son erreur de mise à jour). */
  async desinstaller(cle: string): Promise<void> {
    await desinstallerStore(cle, this.dependancesStore());
    this.oublierMaj(cle);
  }

  /** Une extension partie du registre n'a plus d'erreur de mise à jour. */
  private oublierMaj(cle: string): void {
    if (cle in this.etat.extensions) return;
    this.erreursMaj.delete(cle);
    this.prepareesMaj.delete(cle);
  }

  private dependancesStore(): DependancesStore {
    const o = this.o;
    if (!o) throw new Error("Service des extensions non démarré");
    return {
      dossier: o.dossier,
      etatNavigateur: () => o.magasin.etat,
      etatExtensions: () => this.etat,
      modifier: (changer) => this.modifier(changer),
      demanderAccord: (c, x) => this.demanderAccord(c, x),
      // Avant le chargement : un bloqueur purement déclaratif bloque dès l'installation (fond minimal, rulesets).
      // Un échec est rendu à l'installation (le dossier est retiré, rien n'est inscrit) ; une réussite efface l'erreur
      // d'une préparation précédente de la même clé.
      preparer: async (cle, chemin) => {
        await preparerStore(chemin, o.dossierGardes);
        this.erreursPreparation.delete(cle);
      },
    };
  }

  /** Les erreurs de chaque clé : préparation, dernière mise à jour, chargement (jointes par « ; » quand il y en a plusieurs). */
  erreurs(): Map<string, string> {
    const toutes = new Map<string, string>();
    for (const table of [this.erreursPreparation, this.erreursMaj, this.erreursAgent, this.o?.profils.erreursChargement() ?? new Map<string, string>()])
      for (const [cle, erreur] of table) toutes.set(cle, toutes.has(cle) ? `${toutes.get(cle)} ; ${erreur}` : erreur);
    return toutes;
  }

  /**
   * Cherche les mises à jour des extensions du Store inscrites (toutes, même inactives ou pendant la coupure) et les
   * applique une par une (`appliquerMiseAJour`) : les sessions rechargent une version appliquée pendant l'écriture du
   * registre ; une mise à jour qui demande plus reste en attente ; un échec garde son erreur. Une seule vérification à la
   * fois (un appel pendant une autre rend celle en cours).
   */
  verifierMisesAJour(o: { fetch?: typeof fetch; url?: string } = {}): Promise<void> {
    if (!this.o || !this.pret) return Promise.resolve();
    if (this.verification) return this.verification;
    const d = this.dependancesMaj();
    const entrees = Object.entries(this.etat.extensions).flatMap(([cle, x]) => {
      const lue = lireCle(cle);
      return lue?.source === "store" ? [{ id: lue.id, version: x.version }] : [];
    });
    const verification = (async () => {
      const majs = await chercherMisesAJour(entrees, { fetch: o.fetch ?? fetch, ...(o.url ? { url: o.url } : {}) });
      for (const maj of majs) {
        // Sa file est tenue (une carte d'installation ouverte, par exemple) : elle seule attend la prochaine vérification.
        if (fileStoreOccupee(d.dossier, maj.id)) {
          console.info(`[extensions] mise à jour store:${maj.id} remise à la prochaine vérification (opération en cours)`);
          continue;
        }
        const r = await appliquerMiseAJour(maj, d);
        if (r !== "echec") console.info(`[extensions] mise à jour store:${maj.id} ${maj.version} : ${r}`);
      }
    })().finally(() => {
      this.verification = null;
    });
    this.verification = verification;
    return verification;
  }

  /**
   * Vérifie les mises à jour 60 s après l'appel (puis de 60 s en 60 s tant que le registre n'est pas prêt), ensuite toutes
   * les 5 h. Rien sous `WEBAIOS_INVISIBLE=1` (tests), sauf si
   * `WEBAIOS_TEST_STORE_MAJ_URL` est posée. Rend de quoi l'arrêter.
   */
  planifierMisesAJour(): () => void {
    if (process.env.WEBAIOS_INVISIBLE === "1" && !process.env.WEBAIOS_TEST_STORE_MAJ_URL) return () => {};
    const verifier = () => void this.verifierMisesAJour().catch((e: unknown) => console.error("[extensions] mises à jour :", e));
    let intervalle: ReturnType<typeof setInterval> | undefined;
    // Registre pas encore prêt (démarrage lent) : nouvel essai 60 s plus tard, pas 5 h.
    let premiere: ReturnType<typeof setTimeout>;
    const essayer = () => {
      if (!this.pret) {
        premiere = setTimeout(essayer, PREMIERE_MAJ_MS);
        premiere.unref?.();
        return;
      }
      verifier();
      intervalle = setInterval(verifier, INTERVALLE_MAJ_MS);
      intervalle.unref?.();
    };
    premiere = setTimeout(essayer, PREMIERE_MAJ_MS);
    premiere.unref?.();
    return () => {
      clearTimeout(premiere);
      if (intervalle) clearInterval(intervalle);
    };
  }

  /**
   * « Revoir la mise à jour » : la carte de la version en attente (`maj: { de }`, telle que sur le disque) dans la fenêtre
   * `fenetre`, pour l'espace actif de la fenêtre s'il utilise un profil où elle est active, sinon le premier qui en
   * utilise un. Acceptée (pour la portée en attente) : appliquée, rechargée, l'ancienne version effacée. Refusée : elle
   * reste en attente. Sans mise à jour en attente : `"echec"`, rien n'est montré.
   */
  async revoirMiseAJour(cle: string, fenetre?: IdFenetre): Promise<ResultatMiseAJour> {
    const o = this.o;
    const x = this.etat.extensions[cle];
    const lue = lireCle(cle);
    const m = x?.majEnAttente;
    if (!o || !x || !m || lue?.source !== "store") return "echec";
    const d = this.dependancesMaj();
    const analyse = analyserManifeste(await lireManifeste(join(o.dossier, "store", lue.id, `${m.version}_0`)), { source: "store" });
    if (analyse.refus.length > 0 || analyse.version !== m.version || empreintePortee(analyse.portee) !== empreintePortee(m.portee)) {
      await abandonnerMiseAJour(cle, m.version, d);
      d.noterErreur(cle, `Mise à jour ${m.version} illisible : elle sera téléchargée de nouveau`);
      return "echec";
    }
    const nav = o.magasin.etat;
    const actif = nav.fenetres.find((f) => f.id === fenetre)?.espaceActif;
    const espace =
      nav.espaces.find((e) => e.id === actif && x.profils.includes(e.profil)) ??
      nav.espaces.find((e) => x.profils.includes(e.profil)) ??
      nav.espaces.find((e) => e.id === actif) ??
      nav.espaces[0];
    if (!espace) return "en-attente";
    const carte = carteDe(analyse, { cle, source: "store", espace, etat: nav, maj: { de: x.version } });
    const r = await this.demanderAccord(carte, fenetre ? { fenetre } : {});
    if (!accordPour(r, m.portee)) return "en-attente";
    return accepterMiseAJour(cle, { version: m.version, nom: analyse.nom, portee: m.portee }, d);
  }

  private dependancesMaj(): DependancesMiseAJour {
    const o = this.o;
    if (!o) throw new Error("Service des extensions non démarré");
    return {
      dossier: o.dossier,
      etatExtensions: () => this.etat,
      // Une version préparée par la mise à jour devient l'installée dans cette écriture : l'erreur de préparation de
      // l'ancienne tombe avant que les sessions ne se synchronisent (elles la chargent alors).
      modifier: (changer) =>
        this.modifier((e, prives) => {
          const r = changer(e, prives);
          for (const [cle, version] of this.prepareesMaj)
            if (r.extensions[cle]?.version === version) {
              this.erreursPreparation.delete(cle);
              this.prepareesMaj.delete(cle);
            }
          return r;
        }),
      // Préparée, mais pas encore installée : l'erreur de préparation de la version installée reste.
      preparer: async (cle, chemin) => {
        await preparerStore(chemin, o.dossierGardes);
        const version = /([^/\\]+)_0$/.exec(chemin)?.[1];
        if (version) this.prepareesMaj.set(cle, version);
      },
      chargementRate: (cle) => this.o?.profils.chargementRate?.(cle) ?? null,
      sansPlantage: (cle, f) => this.o?.profils.sansPlantage?.(cle, f) ?? f(),
      noterErreur: (cle, erreur) => {
        if ((this.erreursMaj.get(cle) ?? null) === erreur) return;
        if (erreur === null) this.erreursMaj.delete(cle);
        else this.erreursMaj.set(cle, erreur);
        this.o?.surChange?.();
      },
    };
  }

  /** La clé d'une extension par son id Chromium (Store : son id ; agent : l'id de sa copie), ou null. */
  private cleDeId(idChrome: string): string | null {
    const store = `store:${idChrome}`;
    if (store in this.etat.extensions) return store;
    const agent = this.o?.profils.cleAgent?.(idChrome) ?? Object.entries(this.etat.extensions).find(([c, x]) => x.source === "agent" && x.idChrome === idChrome)?.[0];
    return agent && agent in this.etat.extensions ? agent : null;
  }

  /** L'id Chromium d'une clé (Store : son id ; agent : celui de sa copie, null avant le premier chargement). */
  private idChromeDe(cle: string): string | null {
    const lue = lireCle(cle);
    if (!lue) return null;
    return lue.source === "store" ? lue.id : (this.etat.extensions[cle]?.idChrome ?? null);
  }

  /** Les erreurs d'une clé : préparation, mise à jour, agent, chargement, puis les dernières erreurs de sa console. */
  private erreursDe(cle: string): string[] {
    const r: string[] = [];
    for (const table of [this.erreursPreparation, this.erreursMaj, this.erreursAgent, this.o?.profils.erreursChargement() ?? new Map<string, string>()]) {
      const e = table.get(cle);
      if (e) r.push(e);
    }
    const id = this.idChromeDe(cle);
    if (id) r.push(...this.consoles.erreurs(id).slice(-ERREURS_CONSOLE_PAGE));
    return r;
  }

  /** La page Extensions : une ligne par extension du registre (Store et agent), triée par nom. */
  async liste(): Promise<LigneExtension[]> {
    const o = this.o;
    if (!o) return [];
    const nav = o.magasin.etat;
    const lignes: LigneExtension[] = [];
    for (const [cle, x] of Object.entries(this.etat.extensions)) {
      const lue = lireCle(cle);
      if (!lue) continue;
      const chemin = lue.source === "store" ? join(o.dossier, "store", lue.id, `${x.version}_0`) : join(o.dossier, "copies", lue.id);
      const manifeste = await lireManifeste(chemin);
      // La portée accordée ; sans accord (jamais le cas d'une entrée chargée), celle du manifeste sur le disque.
      const portee = x.accord ?? analyserManifeste(manifeste, { source: x.source }).portee;
      lignes.push({
        cle,
        nom: x.nom,
        source: x.source,
        version: x.version,
        droits: libellesPortee(portee, x.source),
        sites: [...portee.hotes],
        tousLesSites: portee.tousLesSites,
        espaces: nav.espaces
          .filter((e) => x.profils.includes(e.profil) && !(x.source === "agent" && profilPrive(nav, e.profil)))
          .map((e) => ({ nom: e.nom, profil: e.profil })),
        erreurs: this.erreursDe(cle),
        modifieeLe: x.modifieeLe,
        desactivee: x.desactivee ? (x.desactivee.raison === "plantages" ? DESACTIVEE_PLANTAGES : DESACTIVEE_PORTEE) : null,
        majEnAttente: x.majEnAttente?.version ?? null,
        nonPrisEnCharge: nonPrisEnCharge(manifeste),
        epinglee: x.epinglee,
        consoleDebloquee: this.deblocages.has(cle),
      });
    }
    return lignes.sort((a, b) => a.nom.localeCompare(b.nom) || a.cle.localeCompare(b.cle));
  }

  /** La barre de `fenetre` : les extensions chargées dans le profil de son espace actif, et l'onglet qu'elle affiche. */
  barre(fenetre: IdFenetre): BarreExtensions {
    const o = this.o;
    const nav = o?.magasin.etat;
    const f = nav?.fenetres.find((x) => x.id === fenetre);
    const espace = f && nav?.espaces.find((e) => e.id === f.espaceActif);
    if (!o || !f || !espace) return { partition: "", onglet: null, actions: [] };
    const ongletId = f.actif[f.espaceActif];
    const wc = ongletId ? o.vues.vue(ongletId) : null;
    return {
      partition: partitionDe(espace.profil),
      onglet: wc && !wc.isDestroyed() ? wc.id : null,
      actions: o.profils
        .chargeesProfil(espace.profil)
        .map(({ cle, id }) => ({ cle, idChrome: id, nom: this.etat.extensions[cle]?.nom ?? id, epinglee: this.etat.extensions[cle]?.epinglee === true }))
        .sort((a, b) => a.nom.localeCompare(b.nom) || a.cle.localeCompare(b.cle)),
    };
  }

  /** Écrit le registre pour une clé connue (dans la file de l'extension pour le Store) ; une erreur est rendue en texte. */
  private async ecrireCle(cle: string, changer: (e: EtatExtensions, prives: ReadonlySet<IdProfil>) => EtatExtensions): Promise<ResultatExtension> {
    const o = this.o;
    const lue = lireCle(cle);
    if (!o || !this.pret) return { ok: false, erreur: "Service des extensions non démarré" };
    if (!lue || !(cle in this.etat.extensions)) return { ok: false, erreur: `Extension inconnue : ${cle}` };
    try {
      const ecrire = () => this.modifier((e, prives) => (cle in e.extensions ? changer(e, prives) : e));
      await (lue.source === "store" ? enFileStore(o.dossier, lue.id, ecrire) : ecrire());
      return { ok: true };
    } catch (e) {
      return { ok: false, erreur: (e as Error).message };
    }
  }

  epingler(cle: string, oui: boolean): Promise<ResultatExtension> {
    return this.ecrireCle(cle, (e) => epingler(e, cle, oui));
  }

  /** « Désactiver partout » : retirée de tous les profils ; l'accord reste (la réactiver dans un espace suffit). */
  desactiverPartout(cle: string): Promise<ResultatExtension> {
    return this.ecrireCle(cle, (e) => desactiverPartout(e, cle));
  }

  /** « Réactiver » une extension désactivée pour ses plantages : elle repart dans les profils où elle était active. */
  async reactiver(cle: string): Promise<ResultatExtension> {
    const r = await this.ecrireCle(cle, (e) => {
      const x = e.extensions[cle]!;
      return x.desactivee?.raison === "plantages" ? { ...e, extensions: { ...e.extensions, [cle]: { ...x, desactivee: null } } } : e;
    });
    const id = this.idChromeDe(cle);
    if (r.ok && id) this.consoles.oublier(id);
    return r;
  }

  /**
   * « Supprimer » : une extension du Store est désinstallée (déchargée partout, `store/<id>` effacé) ; une extension de
   * l'agent perd son accord et sa copie, son dossier dans `~/WebAiOs/extensions` reste.
   */
  async supprimer(cle: string): Promise<ResultatExtension> {
    const o = this.o;
    const lue = lireCle(cle);
    if (!o || !this.pret) return { ok: false, erreur: "Service des extensions non démarré" };
    if (!lue || !(cle in this.etat.extensions)) return { ok: false, erreur: `Extension inconnue : ${cle}` };
    const id = this.idChromeDe(cle);
    try {
      if (lue.source === "store") await this.desinstaller(cle);
      else {
        const d = this.dependancesAgent();
        // Sans dossier de l'agent (jamais en usage normal) : l'entrée et la copie partent quand même.
        await (d ? supprimerAgent(lue.id, d) : this.desinstaller(cle));
      }
    } catch (e) {
      return { ok: false, erreur: (e as Error).message };
    }
    if (id) this.consoles.oublier(id);
    return { ok: true };
  }

  /**
   * « Désactiver toutes les extensions » : `toutesCoupees` écrit au registre (il survit à un redémarrage) ; tout est
   * déchargé, et ni une installation, ni un rechargement, ni une mise à jour n'y chargent rien tant que c'est vrai.
   */
  async toutCouper(oui: boolean): Promise<ResultatExtension> {
    if (!this.o || !this.pret) return { ok: false, erreur: "Service des extensions non démarré" };
    try {
      await this.modifier((e) => couperTout(e, oui));
      return { ok: true };
    } catch (e) {
      return { ok: false, erreur: (e as Error).message };
    }
  }

  /**
   * « Revoir la mise à jour » (Store, `majEnAttente`) ou « Revoir l'accord » (agent désactivée pour une portée élargie) :
   * la carte, dans `fenetre`. Pendant la coupure générale, aucune carte : la mise à jour reste en attente.
   */
  async revoir(cle: string, fenetre?: IdFenetre): Promise<ResultatExtension> {
    const o = this.o;
    const x = this.etat.extensions[cle];
    const lue = lireCle(cle);
    if (!o || !this.pret) return { ok: false, erreur: "Service des extensions non démarré" };
    if (!x || !lue) return { ok: false, erreur: `Extension inconnue : ${cle}` };
    if (this.etat.toutesCoupees) return { ok: false, erreur: REVOIR_PENDANT_COUPURE };
    if (lue.source === "store" && x.majEnAttente) {
      const r = await this.revoirMiseAJour(cle, fenetre);
      if (r === "appliquee") return { ok: true };
      return { ok: false, erreur: r === "en-attente" ? "Mise à jour refusée : elle reste en attente" : (this.erreursMaj.get(cle) ?? "Mise à jour impossible") };
    }
    if (lue.source === "agent" && x.desactivee?.raison === "portee-elargie") {
      const nav = o.magasin.etat;
      const actif = nav.fenetres.find((f) => f.id === fenetre)?.espaceActif;
      const espace =
        nav.espaces.find((e) => e.id === actif && x.profils.includes(e.profil)) ??
        nav.espaces.find((e) => x.profils.includes(e.profil) && !profilPrive(nav, e.profil)) ??
        nav.espaces.find((e) => e.id === actif);
      if (!espace) return { ok: false, erreur: "Aucun espace où la revoir" };
      return this.demanderActivation(lue.id, { espace, ...(fenetre ? { fenetre } : {}) });
    }
    return { ok: false, erreur: RIEN_A_REVOIR };
  }

  /** `PLANTAGES_MAX` plantages en `FENETRE_PLANTAGES_MS` : désactivée partout (`DESACTIVEE_PLANTAGES`), signalée sur la page. */
  private async desactiverPlantages(idChrome: string): Promise<void> {
    const cle = this.cleDeId(idChrome);
    if (!cle || !this.pret) return;
    const r = await this.ecrireCle(cle, (e) => {
      const x = e.extensions[cle]!;
      return x.desactivee ? e : { ...e, extensions: { ...e.extensions, [cle]: { ...x, desactivee: { raison: "plantages" as const, le: new Date().toISOString() } } } };
    });
    if (!r.ok) throw new Error(r.erreur);
    console.warn(`[extensions] ${cle} désactivée : ${DESACTIVEE_PLANTAGES}`);
  }

  // ——— L'agent (outils MCP) : lister, demander, recharger, console filtrée, déblocage ———

  /** Les outils MCP des extensions, pour le noyau. `fenetreAgent` : la fenêtre d'une demande venue du jeton principal. */
  outilsAgent(o: { fenetreAgent: () => IdFenetre | undefined }): OutilsExtensions {
    return {
      lister: async () => this.listePourAgent(),
      demander: (id, x) => this.demanderPourAgent(id, x, o.fenetreAgent),
      recharger: (id) => this.rechargerPourAgent(id),
      console: async (id, depuis) => this.consolePourAgent(id, depuis),
      debloquerConsole: (id, raison, x) => this.debloquerConsole(id, raison, x, o.fenetreAgent),
      refermerConsole: async (id) => {
        const cle = cleAgentPour(id);
        if (!cle) return { ok: false, erreur: `Extension inconnue : ${id}` };
        this.couperDeblocage(cle);
        return { ok: true };
      },
    };
  }

  /** La fenêtre d'une demande de l'agent : la sienne si elle est ouverte, sinon celle au premier plan. */
  private fenetrePour(fenetre: string | null, fenetreAgent: () => IdFenetre | undefined) {
    const nav = this.o?.magasin.etat;
    return nav?.fenetres.find((f) => f.id === fenetre) ?? nav?.fenetres.find((f) => f.id === fenetreAgent()) ?? nav?.fenetres[0];
  }

  /** Les profils d'une entrée qu'utilise un espace privé. */
  private dansUnProfilPrive(profils: readonly IdProfil[]): boolean {
    const prives = this.o ? profilsPrives(this.o.magasin.etat) : new Set<IdProfil>();
    return profils.some((p) => prives.has(p));
  }

  /**
   * Chaque extension du registre : les espaces non privés où elle est active (nommés), les privés (comptés). Erreurs :
   * celles du service, la désactivation, et pour l'agent les erreurs de sa console filtrées ; jamais la console du Store.
   */
  private listePourAgent(): ExtensionPourAgent[] {
    const nav = this.o?.magasin.etat;
    if (!nav) return [];
    return Object.entries(this.etat.extensions)
      .map(([cle, x]): ExtensionPourAgent => {
        const espaces = nav.espaces.filter((e) => x.profils.includes(e.profil));
        const erreurs: string[] = [];
        for (const table of [this.erreursPreparation, this.erreursMaj, this.erreursAgent, this.o?.profils.erreursChargement() ?? new Map<string, string>()]) {
          const e = table.get(cle);
          if (e) erreurs.push(e);
        }
        if (x.desactivee) erreurs.push(x.desactivee.raison === "plantages" ? DESACTIVEE_PLANTAGES : DESACTIVEE_PORTEE);
        const id = x.source === "agent" ? this.idChromeDe(cle) : null;
        if (id && !this.dansUnProfilPrive(x.profils)) erreurs.push(...this.consoles.erreursPourAgent(id, this.filtreAgent(cle)).slice(-ERREURS_CONSOLE_PAGE));
        return {
          cle,
          source: x.source,
          nom: x.nom,
          version: x.version,
          espaces: espaces.filter((e) => !e.prive).map((e) => e.nom),
          espacesPrives: espaces.filter((e) => e.prive).length,
          erreurs,
        };
      })
      .sort((a, b) => a.nom.localeCompare(b.nom) || a.cle.localeCompare(b.cle));
  }

  /**
   * `demander_extension` : l'espace nommé (id ou nom, jamais un espace privé), sinon l'espace actif de la fenêtre de
   * l'agent ; la carte (`demanderActivation`, délai des questions de l'agent). « Activation refusée » est le refus de
   * L'utilisateur (ou une carte retirée).
   */
  private async demanderPourAgent(
    id: string,
    x: { espace?: string; fenetre: string | null; signal?: AbortSignal },
    fenetreAgent: () => IdFenetre | undefined,
  ): Promise<ResultatDemandeExtension> {
    const nav = this.o?.magasin.etat;
    if (!nav) return { ok: false, erreur: "Service des extensions non démarré" };
    const dossier = cleAgentPour(id)?.slice("agent:".length);
    if (!dossier) return { ok: false, erreur: `Identifiant d'extension invalide : ${id}` };
    const f = this.fenetrePour(x.fenetre, fenetreAgent);
    let espace: Espace | undefined;
    if (x.espace !== undefined) {
      const ouverts = nav.espaces.filter((e) => !e.prive);
      espace = ouverts.find((e) => e.id === x.espace) ?? ouverts.find((e) => e.nom.toLowerCase() === x.espace!.toLowerCase());
      if (!espace) return { ok: false, erreur: `Espace inconnu : ${x.espace}` };
    } else espace = nav.espaces.find((e) => e.id === f?.espaceActif);
    if (!espace) return { ok: false, erreur: "Aucun espace actif" };
    const r = await this.demanderActivation(dossier, {
      espace,
      ...(f ? { fenetre: f.id } : {}),
      delaiMs: DELAI_QUESTION_MS,
      ...(x.signal ? { signal: x.signal } : {}),
    });
    if (r.ok) return { ok: true, espace: espace.nom };
    if (r.erreur === ACTIVATION_REFUSEE) return { ok: false, erreur: r.erreur, refusee: true };
    if (r.erreur === ACTIVATION_RETIREE) return { ok: false, erreur: r.erreur, retiree: true };
    return r;
  }

  /** `recharger_extension` (le masquage de sa console ne change pas : il ne retombe jamais). */
  private rechargerPourAgent(id: string): Promise<ResultatRechargement> {
    const cle = cleAgentPour(id);
    if (!cle) return Promise.resolve({ etat: "refusee", detail: [`Identifiant d'extension invalide : ${id}`] });
    return this.recharger(cle.slice("agent:".length));
  }

  /**
   * L'id Chromium de l'extension de l'agent `cle` : celui du registre, ou, avant que Chromium ne l'ait donné, celui de sa
   * copie (le même : il dérive du dossier).
   */
  private idChromeAgent(cle: string): string | null {
    const lue = lireCle(cle);
    if (!lue || lue.source !== "agent") return null;
    return this.etat.extensions[cle]?.idChrome ?? (this.o ? idChromeDeDossier(join(this.o.dossier, "copies", lue.id)) : null);
  }

  /**
   * Le filtre de la console de `cle` pour l'agent : déblocage ; « a tourné dans un onglet non lisible » (drapeau de
   * l'entrée, ou son id gardé au registre après une suppression) ; droit qui observe les onglets ou la navigation.
   */
  private filtreAgent(cle: string, depuis?: number): FiltreAgent {
    const x = this.etat.extensions[cle];
    const id = this.idChromeAgent(cle);
    const a = x?.accord;
    return {
      ...(depuis !== undefined ? { depuis } : {}),
      debloquee: this.deblocages.has(cle),
      tourneIllisible: (x?.consoleMasquee?.length ?? 0) > 0 || (!!id && !!this.etat.consolesMasquees?.includes(id)),
      observateur: !a || a.tousLesSites || a.scriptsTousLesSites || a.hotes.length > 0 || a.permissions.some((p) => DROITS_OBSERVATEURS.includes(p)),
    };
  }

  /**
   * Une extension de l'agent va tourner dans une vue d'onglet de `profil` que l'agent ne peut pas lire : noté au
   * registre (`consoleMasquee`), une fois par profil. Rien pour un onglet lisible ni pour le Store.
   */
  async aTourneDansOnglet(idChrome: string, profil: IdProfil, lisible: boolean): Promise<void> {
    const o = this.o;
    if (lisible || !o) return;
    const cle = this.cleDeId(idChrome);
    const x = cle ? this.etat.extensions[cle] : undefined;
    if (!cle || x?.source !== "agent" || (x.consoleMasquee?.includes(profil) && this.etat.consolesMasquees?.includes(idChrome))) return;
    const enCours = `${cle}|${profil}`;
    if (this.masquagesEnCours.has(enCours)) return this.masquagesEnCours.get(enCours);
    const ecriture = modifierEtatExtensions(
      o.dossier,
      (e) => {
        const y = e.extensions[cle];
        if (!y) return e;
        // Gardé aussi par id Chromium : il survit à la suppression de l'entrée (recréée au même endroit, même id).
        const masquees = e.consolesMasquees?.includes(idChrome) ? e.consolesMasquees : [...(e.consolesMasquees ?? []), idChrome];
        const profils = y.consoleMasquee?.includes(profil) ? y.consoleMasquee : [...(y.consoleMasquee ?? []), profil];
        return { ...e, consolesMasquees: masquees, extensions: { ...e.extensions, [cle]: { ...y, consoleMasquee: profils } } };
      },
      () => profilsPrives(o.magasin.etat),
    )
      .then((e) => {
        this.etat = e;
        o.surChange?.();
      })
      .finally(() => this.masquagesEnCours.delete(enCours));
    this.masquagesEnCours.set(enCours, ecriture);
    return ecriture;
  }

  /** `console_extension` : la console filtrée (débloquée : entière) ; null si l'extension n'est pas au registre. */
  private consolePourAgent(id: string, depuis?: number): ConsolePourAgent | null {
    const cle = cleAgentPour(id);
    const x = cle ? this.etat.extensions[cle] : undefined;
    if (!cle || !x) return null;
    if (this.dansUnProfilPrive(x.profils)) throw new Error(CONSOLE_PROFIL_PRIVE);
    const idChrome = this.idChromeAgent(cle);
    const f = this.filtreAgent(cle, depuis);
    if (!idChrome) return { messages: [], masques: 0, fondMasque: !f.debloquee && f.tourneIllisible, fondObserve: !f.debloquee && f.observateur, debloquee: f.debloquee };
    return this.consoles.pourAgent(idChrome, f);
  }

  /**
   * `debloquer_console` : la carte de déblocage (même modale que les autres questions de l'agent, Refuser par défaut),
   * pour une extension de l'agent active quelque part, jamais dans le profil d'un espace privé. Elle nomme les espaces
   * des profils où l'extension est active. Accordée : sa console n'est plus filtrée, pour ce que la carte montrait
   * (`LienDeblocage`), jusqu'à `couperDeblocage` ou une écriture du registre qui y met fin (`verifierDeblocages`).
   */
  private async debloquerConsole(
    id: string,
    raison: string,
    x: { fenetre: string | null; agent: string; signal?: AbortSignal },
    fenetreAgent: () => IdFenetre | undefined,
  ): Promise<ResultatConsoleExtension> {
    const cle = cleAgentPour(id);
    const entree = cle ? this.etat.extensions[cle] : undefined;
    if (!cle || !entree) return { ok: false, erreur: `Extension inconnue : ${id}` };
    const refus = this.refusDeblocage(cle);
    if (refus) return { ok: false, erreur: refus };
    if (this.deblocages.has(cle)) return { ok: true };
    const poser = this.poser;
    if (!poser) return { ok: false, erreur: "Questions pas encore branchées" };
    let carte = this.cartesDeblocage.get(cle);
    if (!carte) {
      const f = this.fenetrePour(x.fenetre, fenetreAgent);
      const retrait = new AbortController();
      const lien = this.lienDe(cle)!;
      const nav = this.o?.magasin.etat;
      const champs = {
        permissions: ["console-extension" as const],
        origine: cle,
        titre: entree.nom,
        raison: raison.slice(0, LONGUEUR_RAISON_DEBLOCAGE),
        agent: x.agent,
        espaces: (nav?.espaces ?? []).filter((e) => lien.profils.includes(e.profil) && !e.prive).map((e) => e.nom),
        ...(f ? { fenetreId: f.id } : {}),
      };
      const nouvelle = {
        retrait,
        lien,
        attentes: 0,
        reponse: attendreIssue((repondre) => poser(champs, repondre), DELAI_QUESTION_MS, retrait.signal).finally(() => {
          if (this.cartesDeblocage.get(cle) === nouvelle) this.cartesDeblocage.delete(cle);
        }),
      };
      this.cartesDeblocage.set(cle, nouvelle);
      carte = nouvelle;
    }
    const ouverte = carte;
    ouverte.attentes++;
    // L'abandon de cet appel (nouvelle conversation) ne retire la carte que s'il est le dernier à l'attendre.
    let abandonner: () => void = () => {};
    const abandon = new Promise<Issue>((ok) => (abandonner = () => ok("retiree")));
    let parti = false;
    const partir = () => {
      if (parti) return;
      parti = true;
      if (--ouverte.attentes === 0) ouverte.retrait.abort();
      abandonner();
    };
    if (x.signal?.aborted) partir();
    x.signal?.addEventListener("abort", partir, { once: true });
    let issue: Issue;
    try {
      issue = await Promise.race([ouverte.reponse, abandon]);
    } finally {
      x.signal?.removeEventListener("abort", partir);
      if (!parti) {
        parti = true;
        ouverte.attentes--;
      }
    }
    if (issue === "retiree") return { ok: false, erreur: DEMANDE_RETIREE, retiree: true };
    if (issue !== "autoriser") return { ok: false, erreur: "Déblocage refusé", refusee: true };
    // L'état a pu changer pendant la carte : il est revu au « oui », contre ce que la carte montrait.
    if (this.refusDeblocage(cle) || this.lienRompu(cle, ouverte.lien)) return { ok: false, erreur: DEBLOCAGE_CHANGE };
    this.deblocages.set(cle, ouverte.lien);
    this.o?.surChange?.();
    return { ok: true };
  }

  /** Ce qu'une carte de déblocage montrerait maintenant pour `cle` ; null si elle n'est pas au registre. */
  private lienDe(cle: string): LienDeblocage | null {
    const x = this.etat.extensions[cle];
    if (!x) return null;
    // Avant que Chromium ne l'ait donné, l'id de la copie (le même : il dérive du dossier).
    return { idChrome: this.idChromeAgent(cle), profils: [...x.profils], marque: x.modifieeLe };
  }

  /** Vrai si `cle` n'est plus ce que la carte montrait : autre id, nouvelle copie, ou active dans un autre profil. */
  private lienRompu(cle: string, lien: LienDeblocage): boolean {
    const x = this.etat.extensions[cle];
    if (!x) return true;
    return this.idChromeAgent(cle) !== lien.idChrome || x.modifieeLe !== lien.marque || x.profils.some((p) => !lien.profils.includes(p));
  }

  /** Pourquoi la console de `cle` ne peut pas (ou plus) être débloquée, ou null. */
  private refusDeblocage(cle: string): string | null {
    const x = this.etat.extensions[cle];
    if (!x || x.source !== "agent") return `Extension inconnue : ${cle}`;
    if (this.dansUnProfilPrive(x.profils)) return CONSOLE_PROFIL_PRIVE;
    if (this.etat.toutesCoupees || x.desactivee || x.profils.length === 0) return DEBLOCAGE_INACTIVE;
    return null;
  }

  /**
   * Après chaque écriture du registre : un déblocage dont l'extension est partie, désactivée, coupée, activée dans un
   * autre profil, rechargée (nouvelle copie) ou d'un autre id prend fin ; une carte dans ce cas est retirée.
   */
  private verifierDeblocages(): void {
    let change = false;
    for (const [cle, lien] of [...this.deblocages])
      if (this.refusDeblocage(cle) || this.lienRompu(cle, lien)) {
        this.deblocages.delete(cle);
        change = true;
      }
    for (const [cle, carte] of this.cartesDeblocage) if (this.refusDeblocage(cle) || this.lienRompu(cle, carte.lien)) carte.retrait.abort();
    if (change) this.o?.surChange?.();
  }

  /** « Couper le déblocage » (page Extensions) ou `refermer_console` : la console de `cle` est de nouveau filtrée. */
  couperDeblocage(cle: string): ResultatExtension {
    if (this.deblocages.delete(cle)) this.o?.surChange?.();
    return { ok: true };
  }

  /** L'état du registre tel que chargé. */
  etatExtensions(): EtatExtensions {
    return this.etat;
  }

  /** Correctifs du Store (`storage.sync`…) appliqués à la version installée de chaque extension du Store. */
  private async preparerStore(): Promise<void> {
    const o = this.o!;
    for (const [cle, x] of Object.entries(this.etat.extensions)) {
      const lue = lireCle(cle);
      if (lue?.source !== "store") continue;
      try {
        await preparerStore(join(o.dossier, "store", lue.id, `${x.version}_0`), o.dossierGardes);
        this.erreursPreparation.delete(cle);
      } catch (e) {
        this.erreursPreparation.set(cle, (e as Error).message);
        console.error(`[extensions] ${cle} non préparée :`, e);
      }
    }
  }

  /**
   * Les sessions des profils où une extension est active sont branchées tout de suite (leurs extensions se chargent
   * avant la première page), puis chaque session branchée reçoit ses extensions.
   */
  private async appliquer(): Promise<void> {
    const o = this.o!;
    const nav = o.magasin.etat;
    // Une extension du Store dont la préparation a échoué n'est pas chargée (son erreur reste lisible), ni une extension
    // de l'agent dont le dossier a disparu.
    const e: EtatExtensions = {
      ...this.etat,
      extensions: Object.fromEntries(
        Object.entries(this.etat.extensions).filter(([cle]) => !this.erreursPreparation.has(cle) && !this.agentsBloques.has(cle) && (this.agentsPrets || !cle.startsWith("agent:"))),
      ),
    };
    for (const profil of profilsEnUsage(nav)) if (chargeesDans(e, profil, profilPrive(nav, profil)).length > 0) o.sessions.session(profil);
    await o.profils.synchroniser(e);
  }
}
