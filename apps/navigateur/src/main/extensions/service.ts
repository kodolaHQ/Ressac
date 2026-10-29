import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebContents } from "electron";
import {
  chargeesDans,
  lireCle,
  lireEtatExtensions,
  modifierEtatExtensions,
  preparerStore,
  type EtatExtensions,
  type IdProfil,
} from "@webaios/noyau";
import type { CarteExtension, ReponseAccord } from "../../commun/extensions";
import { aUneVue, profilsEnUsage, type Decision, type Demande, type EtatNavigateur, type IdFenetre } from "../../commun/modele";
import { attendreReponse, questionCaduque } from "../agent/pont";
import type { Magasin } from "../ipc";
import type { GestionnaireVues } from "../onglets/vues";
import type { SessionsProfils } from "../profils-connexion";
import { profilPrive, type CibleOnglet, type ExtensionsProfils } from "./sessions";

/**
 * Pose une question dans une fenêtre (`poserQuestion` d'index.ts) : `fenetreId` absent, celle de l'agent (la fenêtre au
 * premier plan, ou la dernière utilisée). Rend de quoi la retirer.
 */
export type PoserQuestion = (champs: Omit<Demande, "ongletId">, repondre: (d: Decision) => void) => () => void;

/** `reponse`, ou `refus` dès que `signal` tombe. */
function avecSignal<T>(reponse: Promise<T>, signal: AbortSignal | undefined, refus: T): Promise<T> {
  if (!signal) return reponse;
  if (signal.aborted) return Promise.resolve(refus);
  return new Promise((ok) => {
    const abandon = () => ok(refus);
    signal.addEventListener("abort", abandon, { once: true });
    void reponse.then((r) => {
      signal.removeEventListener("abort", abandon);
      ok(r);
    });
  });
}

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

/**
 * Relie le registre des extensions (`<userData>/extensions/etat.json`) aux sessions des profils : au démarrage, il lit
 * le registre, prépare les extensions du Store et charge ce qui est actif ; ensuite, après chaque modification du
 * registre et chaque changement des profils ou de leur caractère privé. Les tâches suivantes y ajoutent leurs méthodes.
 */
export class ServiceExtensions {
  private etat: EtatExtensions = { version: 1, toutesCoupees: false, extensions: {} };
  /** Erreurs de préparation (Store), par clé ; celles du chargement sont dans `ExtensionsProfils`. */
  private erreursPreparation = new Map<string, string>();
  /** Registre lu et Store préparé : les synchronisations peuvent commencer. */
  private pret = false;
  private poser: PoserQuestion | undefined;
  /** Les cartes d'accord affichées, par clé. `connue` : l'extension était dans le registre quand la carte a été posée. */
  private cartes = new Map<string, { reponse: Promise<ReponseAccord>; empreinte: string; retrait: AbortController; connue: boolean }>();
  private o:
    | {
        dossier: string;
        profils: ExtensionsProfils;
        sessions: SessionsProfils;
        vues: GestionnaireVues;
        magasin: Magasin;
        dossierGardes: string;
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
    this.pret = true;
    await this.appliquer();
  }

  /** Modifie le registre (profils privés évalués dans l'écriture), puis recharge les sessions. */
  async modifier(changer: (e: EtatExtensions, profilsPrives: ReadonlySet<IdProfil>) => EtatExtensions): Promise<EtatExtensions> {
    const o = this.o;
    if (!o) throw new Error("Service des extensions non démarré");
    this.etat = await modifierEtatExtensions(o.dossier, changer, () => profilsPrives(o.magasin.etat));
    this.perimerCartes();
    await this.appliquer();
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
   * (`questionCaduque`), sa fenêtre fermée sans autre fenêtre (index.ts).
   */
  demanderAccord(c: CarteExtension, o: { fenetre?: IdFenetre; delaiMs?: number; signal?: AbortSignal }): Promise<ReponseAccord> {
    const refus: ReponseAccord = { accepte: false, empreinte: c.empreinte };
    // Une carte par clé : une deuxième demande rejoint la première (même réponse, même empreinte montrée), sauf si son
    // propre signal tombe avant.
    const ouverte = this.cartes.get(c.cle);
    if (ouverte) return avecSignal(ouverte.reponse, o.signal, { accepte: false, empreinte: ouverte.empreinte });
    const poser = this.poser;
    if (!poser || o.signal?.aborted || this.etat.toutesCoupees) return Promise.resolve(refus);
    const demande = { permissions: ["extension" as const], origine: c.cle, extension: c, ...(o.fenetre ? { fenetreId: o.fenetre } : {}) };
    // Déjà caduque (espace disparu, profil privé pour l'agent) : pas de carte.
    if (this.o && questionCaduque({ ...demande, id: "", ongletId: null }, this.o.magasin.etat)) return Promise.resolve(refus);
    const retrait = new AbortController();
    o.signal?.addEventListener("abort", () => retrait.abort(), { once: true });
    const reponse = attendreReponse((repondre) => poser(demande, repondre), o.delaiMs ?? Infinity, retrait.signal).then(
      (accepte): ReponseAccord => {
        this.cartes.delete(c.cle);
        return { accepte, empreinte: c.empreinte };
      },
    );
    this.cartes.set(c.cle, { reponse, empreinte: c.empreinte, retrait, connue: c.cle in this.etat.extensions });
    return reponse;
  }

  /** Après chaque écriture du registre : les cartes d'une extension retirée, ou toutes si tout est coupé, tombent. */
  private perimerCartes(): void {
    for (const [cle, carte] of this.cartes)
      if (this.etat.toutesCoupees || (carte.connue && !(cle in this.etat.extensions))) carte.retrait.abort();
  }

  /** La dernière erreur de préparation ou de chargement de chaque clé. */
  erreurs(): Map<string, string> {
    return new Map([...this.erreursPreparation, ...(this.o?.profils.erreursChargement() ?? [])]);
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
    // Une extension du Store dont la préparation a échoué n'est pas chargée (son erreur reste lisible).
    const e: EtatExtensions = {
      ...this.etat,
      extensions: Object.fromEntries(Object.entries(this.etat.extensions).filter(([cle]) => !this.erreursPreparation.has(cle))),
    };
    for (const profil of profilsEnUsage(nav)) if (chargeesDans(e, profil, profilPrive(nav, profil)).length > 0) o.sessions.session(profil);
    await o.profils.synchroniser(e);
  }
}
