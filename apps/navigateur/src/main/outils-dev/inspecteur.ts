import type { WebContents } from "electron";
import {
  OngletIntrouvable,
  OutilsDevOccupes,
  type OutilsDevNavigateur,
  type OutilsDevProprietaire,
  type ProfilCpu,
  type ResultatJs,
} from "@webaios/noyau";
import { TamponOnglet, textePile, texteObjet } from "./tampon";

/** Durée d'un profil sans rechargement, par défaut et au plus. */
const DUREE_PROFIL_MS = 5000;
const DUREE_PROFIL_MAX_MS = 30_000;
/** Attente du chargement d'une page rechargée pour un profil. */
const DELAI_CHARGEMENT_MS = 30_000;

type Ecouteur = (methode: string, params: any) => void; // forme libre du protocole

/** Attente de la nouvelle page après un rechargement demandé par l'agent. */
const DELAI_NAVIGATION_MS = 10_000;

const TEXTE_SITE_CHANGE = "L'onglet a changé de site.";
export const TEXTE_REVOQUE = "Ces outils de développement appartiennent à un agent arrêté.";

/** Un onglet inspecté : son débogueur est attaché, ses tampons courent depuis l'attachement. */
interface Inspection {
  wc: WebContents;
  tampon: TamponOnglet;
  /** Origine de la page à l'attachement (null tant qu'elle n'en a pas) : les tampons ne valent que pour elle. */
  origine: string | null;
  /**
   * Le cadre principal a quitté `origine` : plus aucun événement n'est retenu (ni d'un autre site, ni d'un retour sur
   * le premier) jusqu'à ce qu'un appel signale le changement de site et reparte de la page affichée.
   */
  souillee: boolean;
  /** Activation des domaines du protocole. */
  pret: Promise<void>;
  /** Abonnés aux événements du protocole (attente d'un chargement, morceaux d'un instantané). */
  ecouteurs: Set<Ecouteur>;
  /**
   * Profils et instantanés, un à la fois : ils se partagent le profileur de la page. La file suit le travail réel dans
   * la page, pas la réponse à l'appel : un appel abandonné libère la file quand la page a fini.
   */
  lourd: Promise<unknown>;
  /** Rejetée quand l'inspection prend fin (détachement, outils de l'utilisateur) : les commandes en cours échouent avec elle. */
  fin: Promise<never>;
  terminer: (raison: Error) => void;
  debrancher: () => void;
}

function origineDe(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

const erreurAbandon = () => new DOMException("Interrompu.", "AbortError");

function verifierSignal(signal: AbortSignal): void {
  if (signal.aborted) throw erreurAbandon();
}

/** `p`, ou un rejet AbortError dès que `signal` est levé ; `aLAbandon` est alors appelé. */
function sousSignal<T>(p: Promise<T>, signal: AbortSignal, aLAbandon?: () => void): Promise<T> {
  verifierSignal(signal);
  return new Promise<T>((ok, ko) => {
    const abandon = () => {
      aLAbandon?.();
      ko(erreurAbandon());
    };
    signal.addEventListener("abort", abandon, { once: true });
    p.then(ok, ko).finally(() => signal.removeEventListener("abort", abandon));
  });
}

/** Résolue quand `signal` est levé ou que l'inspection prend fin. */
function interruption(i: Inspection, signal: AbortSignal): Promise<void> {
  return new Promise<void>((ok) => {
    if (signal.aborted) return ok();
    signal.addEventListener("abort", () => ok(), { once: true });
    i.fin.catch(() => ok());
  });
}

/** Attend `ms`, ou moins si `avant` se résout d'abord. */
async function pause(ms: number, avant: Promise<void>): Promise<void> {
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([new Promise<void>((ok) => (minuterie = setTimeout(ok, ms))), avant]);
  clearTimeout(minuterie);
}

const cadrePrincipal = (m: string, p: any) => m === "Page.frameNavigated" && !p?.frame?.parentId;

/**
 * Les outils de développement de l'agent, par le débogueur d'Electron (Chrome DevTools Protocol) sur le webContents
 * de l'onglet. Chaque appel attache au besoin. Les outils de développement de l'utilisateur passent avant : ouverts, l'agent
 * se détache et ses appels lèvent OutilsDevOccupes jusqu'à leur fermeture.
 */
export class InspecteurCdp implements OutilsDevNavigateur {
  private readonly inspections = new Map<string, Inspection>();
  /** webContents dont l'utilisateur a ouvert les outils (signalés par « devtools-opened », retirés à « devtools-closed »). */
  private readonly occupes = new WeakSet<WebContents>();
  private readonly suivis = new WeakSet<WebContents>();
  /** Génération du propriétaire courant (voir `proprietaire`). */
  private generation = 0;

  constructor(private readonly webContentsDe: (id: string) => WebContents | undefined) {}

  /** Onglets inspectés en ce moment. */
  attaches(): string[] {
    return [...this.inspections.keys()];
  }

  private lacherTout(): void {
    for (const id of [...this.inspections.keys()]) this.lacher(id);
  }

  /**
   * L'accès d'un noyau. Le navigateur garde son inspecteur quand le noyau change (autre profil d'agent) : un nouveau
   * propriétaire révoque le précédent et détache tout ce qui était attaché. Les appels d'un propriétaire révoqué (noyau
   * arrêté, dont un appel ou une réconciliation était en cours) sont refusés ; un attachement qui aboutit après la
   * révocation est défait aussitôt.
   */
  proprietaire(): OutilsDevProprietaire {
    const g = ++this.generation;
    this.lacherTout();
    const valide = () => {
      if (this.generation !== g) throw new Error(TEXTE_REVOQUE);
    };
    const garde =
      <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
      async (...a: A): Promise<R> => {
        valide();
        return f(...a);
      };
    return {
      attacher: async (id) => {
        valide();
        await this.attacher(id);
        if (this.generation !== g) {
          this.lacher(id);
          valide();
        }
      },
      detacher: async (id) => {
        if (this.generation === g) await this.detacher(id);
      },
      console: garde((id) => this.console(id)),
      reseau: garde((id) => this.reseau(id)),
      corps: garde((id, requete) => this.corps(id, requete)),
      profiler: garde((id, o, signal) => this.profiler(id, o, signal)),
      instantaneMemoire: garde((id, signal) => this.instantaneMemoire(id, signal)),
      executer: garde((id, code, signal) => this.executer(id, code, signal)),
      recharger: garde((id, sansCache) => this.recharger(id, sansCache)),
      attaches: () => (this.generation === g ? this.attaches() : []),
      liberer: () => {
        if (this.generation !== g) return;
        this.generation++;
        this.lacherTout();
      },
    };
  }

  private occupe(wc: WebContents): boolean {
    return !wc.isDestroyed() && (this.occupes.has(wc) || wc.isDevToolsOpened());
  }

  /** Suit l'ouverture des outils de l'utilisateur sur ce webContents, une seule fois par webContents. */
  private suivreOccupation(wc: WebContents): void {
    if (this.suivis.has(wc)) return;
    this.suivis.add(wc);
    wc.on("devtools-opened", () => {
      this.occupes.add(wc);
      for (const [id, i] of this.inspections) if (i.wc === wc) this.lacher(id, new OutilsDevOccupes());
    });
    // Le prochain appel attachera de nouveau.
    wc.on("devtools-closed", () => this.occupes.delete(wc));
  }

  /** Détache le débogueur et vide les tampons ; les commandes en cours échouent avec `raison`. */
  private lacher(id: string, raison: Error = new Error("Les outils de développement de l'agent ont été détachés de l'onglet.")): void {
    const i = this.inspections.get(id);
    if (!i) return;
    this.inspections.delete(id);
    i.debrancher();
    i.terminer(raison);
    i.tampon.vider();
    i.ecouteurs.clear();
    if (!i.wc.isDestroyed() && i.wc.debugger.isAttached()) {
      try {
        i.wc.debugger.detach();
      } catch {
        // déjà détaché
      }
    }
  }

  private brancher(id: string, wc: WebContents): Inspection {
    // Avant l'attachement : Runtime.enable et Log.enable rejouent les messages plus anciens, écartés par le tampon.
    const depuis = Date.now();
    try {
      wc.debugger.attach("1.3");
    } catch (e) {
      if (this.occupe(wc)) throw new OutilsDevOccupes();
      throw e;
    }
    const tampon = new TamponOnglet({ depuis });
    const ecouteurs = new Set<Ecouteur>();
    // Même site : les messages restent, marqués. Autre site : ils ne valent plus rien, et rien n'est plus retenu jusqu'au
    // prochain appel, qui signale le changement de site.
    const navigue = (url: string) => {
      if (inspection.souillee) return;
      const org = origineDe(url);
      if (inspection.origine === null) inspection.origine = org;
      else if (org === inspection.origine) tampon.rechargement();
      else {
        tampon.vider();
        inspection.souillee = true;
      }
    };
    const message = (_e: unknown, methode: string, params: any, sessionId?: string) => {
      if (sessionId) return; // cibles filles (workers…) : seul le cadre principal compte
      // Dans le flux du protocole (et non à « did-navigate », qui arrive après les premiers messages de la nouvelle
      // page) : la marque du rechargement précède ce que la page rechargée écrit.
      if (cadrePrincipal(methode, params)) navigue(String(params.frame.url ?? ""));
      if (!inspection.souillee) tampon.evenement(methode, params);
      for (const f of [...ecouteurs]) f(methode, params);
    };
    const detache = () => {
      if (this.inspections.get(id) === inspection) this.lacher(id);
    };
    const detruit = () => detache();
    wc.debugger.on("message", message);
    wc.debugger.on("detach", detache);
    wc.on("destroyed", detruit);
    const envoyer = (m: string) => wc.debugger.sendCommand(m);
    const pret = Promise.all([envoyer("Runtime.enable"), envoyer("Log.enable"), envoyer("Network.enable"), envoyer("Page.enable")]).then(() => {});
    pret.catch(() => {});
    let terminer: (raison: Error) => void = () => {};
    const fin = new Promise<never>((_, ko) => (terminer = ko));
    fin.catch(() => {});
    const inspection: Inspection = {
      wc,
      tampon,
      origine: origineDe(wc.getURL()),
      souillee: false,
      pret,
      ecouteurs,
      lourd: Promise.resolve(),
      fin,
      terminer,
      debrancher: () => {
        wc.debugger.removeListener("message", message);
        wc.debugger.removeListener("detach", detache);
        if (!wc.isDestroyed()) wc.removeListener("destroyed", detruit);
      },
    };
    this.inspections.set(id, inspection);
    return inspection;
  }

  /**
   * L'inspection doit valoir pour la page affichée : si le cadre principal a changé de site depuis l'attachement (ou
   * pendant l'appel), les tampons repartent de zéro sur le nouveau site et l'appel échoue.
   */
  private verifierSite(i: Inspection): void {
    const org = origineDe(i.wc.getURL());
    if (!i.souillee && i.origine === null) i.origine = org;
    else if (i.souillee || org !== i.origine) {
      i.tampon.vider();
      i.origine = org;
      i.souillee = false;
      throw new Error(TEXTE_SITE_CHANGE);
    }
  }

  /** L'inspection de l'onglet, attachée au besoin, sur le site où elle a commencé. */
  private async assurer(id: string): Promise<Inspection> {
    const wc = this.webContentsDe(id);
    if (!wc || wc.isDestroyed()) {
      this.lacher(id);
      throw new OngletIntrouvable(id);
    }
    this.suivreOccupation(wc);
    if (this.occupe(wc)) {
      this.lacher(id, new OutilsDevOccupes());
      throw new OutilsDevOccupes();
    }
    let i = this.inspections.get(id);
    // L'onglet a un autre webContents (appli relancée…) : l'ancienne inspection ne vaut plus.
    if (i && i.wc !== wc) this.lacher(id);
    i = this.inspections.get(id) ?? this.brancher(id, wc);
    try {
      await Promise.race([i.pret, i.fin]);
    } catch (e) {
      this.lacher(id);
      if (this.occupe(wc)) throw new OutilsDevOccupes();
      throw e;
    }
    this.verifierSite(i);
    return i;
  }

  /** Une commande du protocole ; elle échoue dès la fin de l'inspection (OutilsDevOccupes si l'utilisateur a ouvert ses outils). */
  private async envoyer<T = any>(i: Inspection, methode: string, params?: object): Promise<T> {
    try {
      return await Promise.race([i.wc.debugger.sendCommand(methode, params) as Promise<T>, i.fin]);
    } catch (e) {
      if (this.occupe(i.wc)) throw new OutilsDevOccupes();
      throw e;
    }
  }

  /** Le premier événement qui passe `filtre` (ou rien au bout de `delaiMs`). */
  private attendreEvenement(i: Inspection, filtre: (methode: string, params: any) => boolean, delaiMs: number): { promesse: Promise<void>; annuler: () => void } {
    let annuler = () => {};
    const promesse = new Promise<void>((ok) => {
      const minuterie = setTimeout(fin, delaiMs);
      const ecouteur: Ecouteur = (m, p) => {
        if (filtre(m, p)) fin();
      };
      function fin() {
        clearTimeout(minuterie);
        i.ecouteurs.delete(ecouteur);
        ok();
      }
      annuler = fin;
      i.ecouteurs.add(ecouteur);
    });
    return { promesse, annuler };
  }

  /** Enchaîne les travaux lourds d'un onglet (profils, instantanés) ; `f` est le travail dans la page, sans abandon. */
  private enFile<T>(i: Inspection, f: () => Promise<T>): Promise<T> {
    const suite = i.lourd.then(f, f);
    i.lourd = suite.catch(() => {});
    return suite;
  }

  async attacher(id: string): Promise<void> {
    await this.assurer(id);
  }

  async detacher(id: string): Promise<void> {
    this.lacher(id);
  }

  async console(id: string) {
    return (await this.assurer(id)).tampon.console();
  }

  async reseau(id: string) {
    return (await this.assurer(id)).tampon.reseau();
  }

  async corps(id: string, requete: string): Promise<{ corps: string; base64: boolean }> {
    const i = await this.assurer(id);
    const r = await this.envoyer<{ body: string; base64Encoded: boolean }>(i, "Network.getResponseBody", { requestId: requete });
    return { corps: r.body, base64: r.base64Encoded };
  }

  async profiler(
    id: string,
    o: { dureeMs?: number; recharger?: boolean },
    signal: AbortSignal,
  ): Promise<{ profil: ProfilCpu; metriques: Record<string, number> }> {
    verifierSignal(signal);
    const i = await this.assurer(id);
    const travail = this.enFile(i, async () => {
      verifierSignal(signal); // abandonné dans la file : rien n'a commencé
      await this.envoyer(i, "Profiler.enable");
      await this.envoyer(i, "Performance.enable");
      await this.envoyer(i, "Profiler.start");
      let arrete = false;
      try {
        verifierSignal(signal);
        const stop = interruption(i, signal);
        if (o.recharger) {
          const charge = this.attendreEvenement(i, (m) => m === "Page.loadEventFired", DELAI_CHARGEMENT_MS);
          await this.envoyer(i, "Page.reload");
          await Promise.race([charge.promesse, stop]);
          charge.annuler();
        } else {
          await pause(Math.min(Math.max(0, o.dureeMs ?? DUREE_PROFIL_MS), DUREE_PROFIL_MAX_MS), stop);
        }
        verifierSignal(signal);
        arrete = true;
        const { profile } = await this.envoyer<{ profile: ProfilCpu }>(i, "Profiler.stop");
        const { metrics } = await this.envoyer<{ metrics: { name: string; value: number }[] }>(i, "Performance.getMetrics");
        return { profil: profile, metriques: Object.fromEntries(metrics.map((m) => [m.name, m.value])) };
      } finally {
        // Abandon ou erreur : le profileur est arrêté avant que la file passe au suivant.
        if (!arrete) await this.envoyer(i, "Profiler.stop").catch(() => {});
      }
    });
    return sousSignal(travail, signal);
  }

  async instantaneMemoire(id: string, signal: AbortSignal): Promise<string> {
    verifierSignal(signal);
    const i = await this.assurer(id);
    // Le protocole ne sait pas interrompre un instantané : abandonné, il va à son terme dans la file, et ses morceaux
    // (reçus par son propre écouteur) sont jetés.
    const travail = this.enFile(i, async () => {
      verifierSignal(signal);
      const morceaux: string[] = [];
      const ecouteur: Ecouteur = (m, p) => {
        if (m === "HeapProfiler.addHeapSnapshotChunk") morceaux.push(p.chunk);
      };
      i.ecouteurs.add(ecouteur);
      try {
        await this.envoyer(i, "HeapProfiler.enable");
        await this.envoyer(i, "HeapProfiler.takeHeapSnapshot", { reportProgress: false });
        return morceaux.join("");
      } finally {
        i.ecouteurs.delete(ecouteur);
      }
    });
    return sousSignal(travail, signal);
  }

  async executer(id: string, code: string, signal: AbortSignal): Promise<ResultatJs> {
    verifierSignal(signal);
    const i = await this.assurer(id);
    const groupe = "webaios-executer";
    // Sans contextId : le monde principal du cadre principal. La valeur est gardée côté page puis demandée par valeur,
    // pour que le code ne tourne qu'une fois même si elle n'est pas sérialisable (aperçu textuel alors).
    const evaluation = (async (): Promise<ResultatJs> => {
      try {
        const r = await this.envoyer<{ result: any; exceptionDetails?: any }>(i, "Runtime.evaluate", {
          expression: code,
          awaitPromise: true,
          returnByValue: false,
          objectGroup: groupe,
          replMode: true,
        });
        if (r.exceptionDetails) return { exception: texteException(r.exceptionDetails) };
        const resultat = r.result;
        if (!resultat.objectId) return { valeur: valeurJson(resultat) };
        try {
          const parValeur = await this.envoyer<{ result: any; exceptionDetails?: any }>(i, "Runtime.callFunctionOn", {
            functionDeclaration: "function () { return this; }",
            objectId: resultat.objectId,
            returnByValue: true,
          });
          if (!parValeur.exceptionDetails && "value" in parValeur.result) return { valeur: valeurJson(parValeur.result) };
        } catch (e) {
          if (e instanceof OutilsDevOccupes) throw e;
          // non sérialisable (cycle, nœud du DOM…) : aperçu textuel
        }
        return { valeur: resultat.description ?? String(resultat.type) };
      } finally {
        void this.envoyer(i, "Runtime.releaseObjectGroup", { objectGroup: groupe }).catch(() => {});
      }
    })();
    // Abandon : une boucle sans fin dans la page est interrompue (au mieux).
    const r = await sousSignal(evaluation, signal, () => void this.envoyer(i, "Runtime.terminateExecution").catch(() => {}));
    // Le code a pu faire naviguer la page vers un autre site : sa réponse ne vaut plus.
    this.verifierSite(i);
    return r;
  }

  async recharger(id: string, sansCache: boolean): Promise<void> {
    const i = await this.assurer(id);
    const navigation = this.attendreEvenement(i, cadrePrincipal, DELAI_NAVIGATION_MS);
    if (sansCache) i.wc.reloadIgnoringCache();
    else i.wc.reload();
    await Promise.race([navigation.promesse, i.fin.catch(() => {})]);
    navigation.annuler();
    if (this.inspections.get(id) !== i) {
      if (this.occupe(i.wc)) throw new OutilsDevOccupes();
      return;
    }
    // Une redirection du serveur a pu mener ailleurs.
    this.verifierSite(i);
  }
}

/** Valeur renvoyée par valeur, en JSON ; `undefined`, NaN, Infinity, -0 et les BigInt n'ont pas de JSON. */
function valeurJson(r: { type?: string; value?: unknown; unserializableValue?: string; description?: string }): string {
  if (r.type === "undefined") return "undefined";
  if (r.unserializableValue !== undefined) return r.unserializableValue;
  if ("value" in r) return JSON.stringify(r.value) ?? texteObjet(r);
  return texteObjet(r);
}

/** Description de l'exception (sa pile comprise pour une Error), sinon le texte du protocole avec la pile. */
function texteException(d: { text?: string; exception?: { description?: string; value?: unknown; type?: string }; stackTrace?: Parameters<typeof textePile>[0] }): string {
  const description = d.exception ? (d.exception.description ?? texteObjet(d.exception)) : (d.text ?? "Exception");
  const pile = textePile(d.stackTrace);
  return pile && !description.includes("\n    at ") ? `${description}\n${pile}` : description;
}
