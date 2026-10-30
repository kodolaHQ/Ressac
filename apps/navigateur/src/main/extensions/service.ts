import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebContents } from "electron";
import {
  analyserManifeste,
  chargeesDans,
  empreintePortee,
  lireCle,
  lireEtatExtensions,
  modifierEtatExtensions,
  preparerStore,
  type EtatExtensions,
  type IdProfil,
} from "@webaios/noyau";
import { carteDe, type CarteExtension, type ReponseAccord } from "../../commun/extensions";
export { DESACTIVEE_PLANTAGES, DESACTIVEE_PORTEE } from "../../commun/extensions";
import { aUneVue, profilsEnUsage, type Decision, type Demande, type Espace, type EtatNavigateur, type IdFenetre } from "../../commun/modele";
import { attendreReponse, questionCaduque } from "../agent/pont";
import type { Magasin } from "../ipc";
import type { GestionnaireVues } from "../onglets/vues";
import type { SessionsProfils } from "../profils-connexion";
import {
  demanderActivation,
  demarrerAgents,
  preparerAgent,
  recharger,
  type DependancesAgent,
  type PreparationAgent,
  type ResultatActivation,
  type ResultatRechargement,
} from "./agent";
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
export type PoserQuestion = (champs: Omit<Demande, "ongletId">, repondre: (d: Decision) => void) => () => void;

/** Une carte affichée : `attentes` demandes l'attendent ; `connue` : l'extension était dans le registre à sa pose. */
interface CarteOuverte {
  cle: string;
  reponse: Promise<boolean>;
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
  /** Registre lu et Store préparé : les synchronisations peuvent commencer. */
  private pret = false;
  private poser: PoserQuestion | undefined;
  /** Les cartes d'accord affichées, par clé. `connue` : l'extension était dans le registre quand la carte a été posée. */
  private cartes = new Map<string /* signatureCarte */, CarteOuverte>();
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
      prives = p;
      enUsage = u;
      // Tout de suite, hors de la file : aucune page d'un espace privé ne se charge avec une extension de l'agent.
      o.profils.retirerAgentsPrives(etat);
      if (this.pret) void this.appliquer();
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
    await this.appliquer();
  }

  /** Modifie le registre (profils privés évalués dans l'écriture), puis recharge les sessions. */
  async modifier(changer: (e: EtatExtensions, profilsPrives: ReadonlySet<IdProfil>) => EtatExtensions): Promise<EtatExtensions> {
    const o = this.o;
    if (!o) throw new Error("Service des extensions non démarré");
    this.etat = await modifierEtatExtensions(o.dossier, changer, () => profilsPrives(o.magasin.etat));
    this.perimerCartes();
    // Pendant le démarrage (extensions de l'agent recopiées), le premier chargement vient ensuite.
    if (this.pret) await this.appliquer();
    o.surChange?.();
    return this.etat;
  }

  /**
   * Note la version démarrée d'une extension dans un profil (`vues[profil]`, pour `onInstalled` et les rulesets du
   * manifeste). Lu et écrit dans la même modification sérialisée : deux démarrages simultanés n'ont qu'une seule
   * « première fois ». Les sessions ne sont pas resynchronisées (les vues ne changent pas ce qui est chargé).
   */
  async noterVue(cle: string, profil: IdProfil, version: string): Promise<{ nouvelle: boolean; precedente?: string }> {
    const o = this.o;
    if (!o) throw new Error("Service des extensions non démarré");
    // Un service worker MV3 redémarre à chaque réveil : le cas courant (déjà vue) n'écrit rien. `this.etat` suit chaque
    // écriture du service, seul à écrire le registre pendant que l'application tourne.
    const connue = this.etat.extensions[cle];
    if (!connue || connue.vues[profil] === version) return { nouvelle: false };
    let resultat: { nouvelle: boolean; precedente?: string } = { nouvelle: false };
    this.etat = await modifierEtatExtensions(
      o.dossier,
      (e) => {
        const x = e.extensions[cle];
        const precedente = x?.vues[profil];
        if (!x || precedente === version) return e;
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
    const refus: ReponseAccord = { accepte: false, empreinte: c.empreinte };
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
        reponse: Promise.resolve(false),
        retrait,
        connue: c.cle in this.etat.extensions,
        attentes: 0,
        pendantCoupure: o.pendantCoupure === true,
      };
      // La carte elle-même n'a pas de délai : chaque demande a le sien (ci-dessous). Elle tombe quand plus personne ne
      // l'attend, ou par `perimerCartes`.
      ouverte.reponse = attendreReponse((repondre) => poser(demande, repondre), Infinity, retrait.signal).finally(() => {
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
      const finir = (accepte: boolean) => {
        if (finie) return;
        finie = true;
        clearTimeout(minuterie);
        o.signal?.removeEventListener("abort", partir);
        ok({ accepte, empreinte });
      };
      const partir = () => {
        if (finie) return;
        finir(false);
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
    };
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
      noterErreur: (cle, erreur) => {
        if ((this.erreursMaj.get(cle) ?? null) === erreur) return;
        if (erreur === null) this.erreursMaj.delete(cle);
        else this.erreursMaj.set(cle, erreur);
        this.o?.surChange?.();
      },
    };
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
