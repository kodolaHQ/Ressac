import type { WebContents } from "electron";
import { OngletIntrouvable, OutilsDevOccupes, type OutilsDevNavigateur, type ProfilCpu, type ResultatJs } from "@webaios/noyau";
import { TamponOnglet, textePile, texteObjet } from "./tampon";

/** Durée d'un profil sans rechargement, par défaut et au plus. */
const DUREE_PROFIL_MS = 5000;
const DUREE_PROFIL_MAX_MS = 30_000;
/** Attente du chargement d'une page rechargée pour un profil. */
const DELAI_CHARGEMENT_MS = 30_000;

type Ecouteur = (methode: string, params: any) => void; // forme libre du protocole

/** Un onglet inspecté : son débogueur est attaché, ses tampons courent depuis l'attachement. */
interface Inspection {
  wc: WebContents;
  tampon: TamponOnglet;
  /** Origine de la page à l'attachement (null tant qu'elle n'en a pas) : les tampons ne valent que pour elle. */
  origine: string | null;
  /** Activation des domaines du protocole. */
  pret: Promise<void>;
  /** Abonnés aux événements du protocole (attente d'un chargement, morceaux d'un instantané). */
  ecouteurs: Set<Ecouteur>;
  /** Profils et instantanés, un à la fois : ils se partagent le profileur de la page. */
  lourd: Promise<unknown>;
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

/** `p`, ou un rejet AbortError dès que `signal` est levé ; `aLAbandon` est alors appelé (arrêt du profileur…). */
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

  constructor(private readonly webContentsDe: (id: string) => WebContents | undefined) {}

  private occupe(wc: WebContents): boolean {
    return this.occupes.has(wc) || wc.isDevToolsOpened();
  }

  /** Suit l'ouverture des outils de l'utilisateur sur ce webContents, une seule fois par webContents. */
  private suivreOccupation(wc: WebContents): void {
    if (this.suivis.has(wc)) return;
    this.suivis.add(wc);
    wc.on("devtools-opened", () => {
      this.occupes.add(wc);
      for (const [id, i] of this.inspections) if (i.wc === wc) this.lacher(id);
    });
    // Le prochain appel attachera de nouveau.
    wc.on("devtools-closed", () => this.occupes.delete(wc));
  }

  /** Détache le débogueur et vide les tampons. */
  private lacher(id: string): void {
    const i = this.inspections.get(id);
    if (!i) return;
    this.inspections.delete(id);
    i.debrancher();
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
    try {
      wc.debugger.attach("1.3");
    } catch (e) {
      if (this.occupe(wc)) throw new OutilsDevOccupes();
      throw e;
    }
    const tampon = new TamponOnglet();
    const ecouteurs = new Set<Ecouteur>();
    // Même site : les messages restent, marqués ; autre site : ils ne valent plus rien. L'origine retenue reste
    // l'ancienne, pour que l'appel suivant signale le changement de site.
    const navigue = (url: string) => {
      const org = origineDe(url);
      if (inspection.origine === null) inspection.origine = org;
      else if (org === inspection.origine) tampon.rechargement();
      else tampon.vider();
    };
    const message = (_e: unknown, methode: string, params: any, sessionId?: string) => {
      if (sessionId) return; // cibles filles (workers…) : seul le cadre principal compte
      // Dans le flux du protocole (et non à « did-navigate », qui arrive après les premiers messages de la nouvelle
      // page) : la marque du rechargement précède ce que la page rechargée écrit.
      if (methode === "Page.frameNavigated" && !params?.frame?.parentId) navigue(String(params.frame.url ?? ""));
      tampon.evenement(methode, params);
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
    const inspection: Inspection = {
      wc,
      tampon,
      origine: origineDe(wc.getURL()),
      pret,
      ecouteurs,
      lourd: Promise.resolve(),
      debrancher: () => {
        wc.debugger.removeListener("message", message);
        wc.debugger.removeListener("detach", detache);
        if (!wc.isDestroyed()) wc.removeListener("destroyed", detruit);
      },
    };
    this.inspections.set(id, inspection);
    return inspection;
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
      this.lacher(id);
      throw new OutilsDevOccupes();
    }
    let i = this.inspections.get(id);
    // L'onglet a un autre webContents (appli relancée…) : l'ancienne inspection ne vaut plus.
    if (i && i.wc !== wc) this.lacher(id);
    i = this.inspections.get(id) ?? this.brancher(id, wc);
    try {
      await i.pret;
    } catch (e) {
      this.lacher(id);
      throw e;
    }
    const org = origineDe(wc.getURL());
    if (i.origine === null) i.origine = org;
    else if (org !== i.origine) {
      i.tampon.vider();
      i.origine = org;
      throw new Error("L'onglet a changé de site.");
    }
    return i;
  }

  private envoyer<T = any>(i: Inspection, methode: string, params?: object): Promise<T> {
    return i.wc.debugger.sendCommand(methode, params) as Promise<T>;
  }

  /** Le premier événement `methode` (ou rien au bout de `delaiMs`). */
  private attendreEvenement(i: Inspection, methode: string, delaiMs: number): { promesse: Promise<void>; annuler: () => void } {
    let annuler = () => {};
    const promesse = new Promise<void>((ok) => {
      const minuterie = setTimeout(fin, delaiMs);
      const ecouteur: Ecouteur = (m) => m === methode && fin();
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

  /** Enchaîne les travaux lourds d'un onglet (profils, instantanés). */
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
    return this.enFile(i, async () => {
      verifierSignal(signal);
      let demarre = false;
      let arrete = false;
      /** Arrête le profileur une seule fois, s'il tourne (abandon). */
      const arreter = () => {
        if (!demarre || arrete) return;
        arrete = true;
        void this.envoyer(i, "Profiler.stop").catch(() => {});
      };
      const travail = async () => {
        await this.envoyer(i, "Profiler.enable");
        await this.envoyer(i, "Performance.enable");
        await this.envoyer(i, "Profiler.start");
        demarre = true;
        try {
          // Levé pendant le démarrage : ses écouteurs ne seraient jamais appelés.
          verifierSignal(signal);
          if (o.recharger) {
            const charge = this.attendreEvenement(i, "Page.loadEventFired", DELAI_CHARGEMENT_MS);
            signal.addEventListener("abort", charge.annuler, { once: true });
            await this.envoyer(i, "Page.reload");
            await charge.promesse;
          } else {
            const duree = Math.min(Math.max(0, o.dureeMs ?? DUREE_PROFIL_MS), DUREE_PROFIL_MAX_MS);
            await new Promise<void>((ok) => {
              const minuterie = setTimeout(ok, duree);
              signal.addEventListener("abort", () => (clearTimeout(minuterie), ok()), { once: true });
            });
          }
          verifierSignal(signal);
          arrete = true;
          const { profile } = await this.envoyer<{ profile: ProfilCpu }>(i, "Profiler.stop");
          const { metrics } = await this.envoyer<{ metrics: { name: string; value: number }[] }>(i, "Performance.getMetrics");
          return { profil: profile, metriques: Object.fromEntries(metrics.map((m) => [m.name, m.value])) };
        } finally {
          if (signal.aborted) arreter();
        }
      };
      return sousSignal(travail(), signal, arreter);
    });
  }

  async instantaneMemoire(id: string, signal: AbortSignal): Promise<string> {
    verifierSignal(signal);
    const i = await this.assurer(id);
    return this.enFile(i, async () => {
      verifierSignal(signal);
      const morceaux: string[] = [];
      const ecouteur: Ecouteur = (m, p) => {
        if (m === "HeapProfiler.addHeapSnapshotChunk") morceaux.push(p.chunk);
      };
      i.ecouteurs.add(ecouteur);
      // Le protocole ne sait pas interrompre un instantané : à l'abandon, ses morceaux sont ignorés.
      const arreter = () => i.ecouteurs.delete(ecouteur);
      try {
        await sousSignal(
          (async () => {
            await this.envoyer(i, "HeapProfiler.enable");
            await this.envoyer(i, "HeapProfiler.takeHeapSnapshot", { reportProgress: false });
          })(),
          signal,
          arreter,
        );
        return morceaux.join("");
      } finally {
        arreter();
      }
    });
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
        } catch {
          // non sérialisable (cycle, nœud du DOM…) : aperçu textuel
        }
        return { valeur: resultat.description ?? String(resultat.type) };
      } finally {
        void this.envoyer(i, "Runtime.releaseObjectGroup", { objectGroup: groupe }).catch(() => {});
      }
    })();
    return sousSignal(evaluation, signal);
  }

  async recharger(id: string, sansCache: boolean): Promise<void> {
    const { wc } = await this.assurer(id);
    if (sansCache) wc.reloadIgnoringCache();
    else wc.reload();
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
