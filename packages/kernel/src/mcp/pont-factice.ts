import type { DevRight } from "../access/policy.js";
import type { CpuProfile } from "../devtools/summaries.js";
import type { ReadPage } from "../workflows/protocole.js";
import {
  TabNotFound,
  PrivateTab,
  DevToolsBusy,
  ProfileDenied,
  type BrowserHistory,
  type MessageConsole,
  type TabInfo,
  type PageReadOptions,
  type KeptPage,
  type BrowserDevTools,
  type BrowserBridge,
  type NetworkRequest,
  type HistoryResult,
  type JsResult,
} from "./pont.js";

// Transparent 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const PROFILE: CpuProfile = {
  nodes: [
    { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2] },
    { id: 2, callFrame: { functionName: "calculer", url: "http://exemple/app.js", lineNumber: 9 } },
  ],
  samples: [2, 2, 1],
  timeDeltas: [0, 1000, 1000],
  startTime: 0,
  endTime: 3000,
};

/** A minimal `.heapsnapshot`: `n` « Fuite » objects of 100 bytes. */
function heap(n: number): string {
  const nodes: number[] = [];
  for (let i = 0; i < n; i++) nodes.push(3, 0, i + 1, 100, 0);
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count"],
        node_types: [["hidden", "array", "string", "object", "code", "closure", "regexp", "number", "native"], "string", "number", "number", "number"],
      },
    },
    nodes,
    strings: ["Fuite"],
  });
}

/** Waits for abandonment: an operation that never ends on its own. */
const pending = <T>(signal: AbortSignal): Promise<T> =>
  new Promise<T>((_, ko) => {
    const reject = () => ko(new Error("Interrompu"));
    if (signal.aborted) reject();
    else signal.addEventListener("abort", reject, { once: true });
  });

/** Simulated dev tools: buffers set by the tests. */
class FakeDevTools implements BrowserDevTools {
  readonly consoles = new Map<string, MessageConsole[]>();
  readonly reseaux = new Map<string, NetworkRequest[]>();
  readonly occupes = new Set<string>();
  objetsTas = 2;

  constructor(
    private readonly noter: (method: string, ...args: unknown[]) => void,
    private readonly trouver: (id: string) => TabInfo,
    private readonly bloquer: boolean,
  ) {}

  private verifier(id: string): void {
    this.trouver(id);
    if (this.occupes.has(id)) throw new DevToolsBusy();
  }

  async attacher(id: string) {
    this.noter("attacher", id);
    this.verifier(id);
  }

  async detacher(id: string) {
    this.noter("detacher", id);
  }

  async console(id: string) {
    this.noter("console", id);
    this.verifier(id);
    return [...(this.consoles.get(id) ?? [])];
  }

  async reseau(id: string) {
    this.noter("reseau", id);
    this.verifier(id);
    return [...(this.reseaux.get(id) ?? [])];
  }

  async corps(id: string, request: string) {
    this.noter("corps", id, request);
    this.verifier(id);
    return { corps: `Corps de ${request}`, base64: false };
  }

  async profiler(id: string, o: { dureeMs?: number; recharger?: boolean }, signal: AbortSignal) {
    this.noter("profiler", id, o);
    this.verifier(id);
    if (this.bloquer) return pending<{ profil: CpuProfile; metriques: Record<string, number> }>(signal);
    return { profil: PROFILE, metriques: { Nodes: 42 } };
  }

  async instantaneMemoire(id: string, signal: AbortSignal) {
    this.noter("instantaneMemoire", id);
    this.verifier(id);
    if (this.bloquer) return pending<string>(signal);
    return heap(this.objetsTas);
  }

  async executer(id: string, code: string, _signal: AbortSignal): Promise<JsResult> {
    this.noter("executer", id, code);
    this.verifier(id);
    if (code.startsWith("throw ")) return { exception: `${code.slice(6)}\n    at <anonymous>:1:1` };
    return { valeur: JSON.stringify({ code }) };
  }

  async recharger(id: string, noCache: boolean) {
    this.noter("recharger", id, noCache);
    this.verifier(id);
  }
}

/** Simulated browser: for the tests and the dev command. */
export class FakeBridge implements BrowserBridge {
  readonly appels: { methode: string; args: unknown[] }[] = [];
  private readonly onglets: TabInfo[];
  private actif: string | null;
  private readonly autoriser: boolean;
  private compteur = 0;
  /** Tabs in a private space: invisible, as in the real browser. */
  private readonly prives = new Set<string>();
  readonly outilsDev?: FakeDevTools;
  readonly historique?: BrowserHistory;
  lirePageInvisible?: (url: string, o: PageReadOptions) => Promise<ReadPage>;
  lireHtmlInvisible?: (url: string, o: { adressesLocales?: boolean; signal?: AbortSignal }) => Promise<{ url: string; html: string }>;
  /** Suspended reads in progress, by URL: `relacher` lets them finish. */
  private readonly suspendues = new Map<string, (() => void)[]>();
  demanderDonneesWidget?: (o: { id: string; nom: string; agent: string; genre?: "action" | "site" }, signal?: AbortSignal) => Promise<boolean>;
  /** Domains of each site app (id → domains), for `adresseSitePermise`. */
  private readonly sites: Record<string, string[]>;
  /** Site apps whose tweaks card is shown: navigating answers « en-attente ». */
  private readonly sitesEnAttente: Set<string>;
  demanderOutilsDev?: (o: TabInfo, d: { droits: DevRight[]; raison: string; agent: string }, signal?: AbortSignal) => Promise<DevRight[]>;

  /**
   * `outilsDev` provides the simulated dev tools; `accorderDev` also provides the consent card,
   * which answers these rights. `bloquer`: profiles and snapshots only end on abandonment. `historique` provides
   * the history: `chercher` returns `resultats` (at most `limite`), `lire` the page of `textes` at this URL, and
   * `erreur`, if given, makes both fail. `lecture` provides `lirePageInvisible`: the page of `pages` at this URL
   * (otherwise an empty page), `lireHtmlInvisible`: the HTML of `html` at this URL (otherwise ""), and ProfileDenied for a profile of `refuser`. A read (page or HTML) of a URL of `suspendues` only
   * ends at `relacher(url)`, or at the abandonment of its `signal`: it is then noted « lectureAnnulee » and rejected with
   * the signal's reason, like the real bridge that closes its window. `redirections` simulates a redirect:
   * the requested URL leads to the associated URL, and that page is the one returned; to another host, with
   * `changerHote`, it waits for it first (noted « changerHote »). `donneesWidget` provides the
   * « donnees-widget » card (and that of a site app, `genre: "site"`), which answers this value. `sites`: the domains
   * of each open site app (`site:<id>` tabs with `site` set), for `adresseSitePermise`.
   */
  constructor(
    tabs: TabInfo[],
    o: {
      actif: string | null;
      autoriser: boolean;
      outilsDev?: boolean;
      accorderDev?: DevRight[];
      bloquer?: boolean;
      historique?: { resultats: HistoryResult[]; textes?: KeptPage[]; erreur?: string };
      lecture?: { pages: ReadPage[]; html?: Record<string, string>; refuser?: string[]; redirections?: Record<string, string>; suspendues?: string[] };
      donneesWidget?: boolean;
      sites?: Record<string, string[]>;
      sitesEnAttente?: string[];
    },
  ) {
    this.sites = o.sites ?? {};
    this.sitesEnAttente = new Set(o.sitesEnAttente ?? []);
    this.onglets = tabs.map((x) => ({ ...x }));
    this.actif = o.actif;
    this.autoriser = o.autoriser;
    if (o.outilsDev || o.accorderDev) {
      this.outilsDev = new FakeDevTools((m, ...a) => this.noter(m, ...a), (id) => this.trouver(id), o.bloquer ?? false);
    }
    const h = o.historique;
    if (h) {
      const fail = () => {
        if (h.erreur) throw new Error(h.erreur);
      };
      this.historique = {
        chercher: async (q) => {
          this.noter("chercherHistorique", { ...q });
          fail();
          return h.resultats.slice(0, q.limite).map((r) => ({ ...r }));
        },
        lire: async (url) => {
          this.noter("lireHistorique", url);
          fail();
          const p = h.textes?.find((x) => x.url === url);
          return p ? { ...p } : null;
        },
      };
    }
    const reading = o.lecture;
    if (reading) {
      const wait = async (url: string, signal: AbortSignal | undefined) => {
        if (signal?.aborted) throw signal.reason;
        if (!reading.suspendues?.includes(url)) return;
        await new Promise<void>((ok, ko) => {
          const end = () => {
            signal?.removeEventListener("abort", cancel);
            ok();
          };
          const cancel = () => {
            this.suspendues.set(url, (this.suspendues.get(url) ?? []).filter((f) => f !== end));
            this.noter("lectureAnnulee", url);
            ko(signal!.reason);
          };
          this.suspendues.set(url, [...(this.suspendues.get(url) ?? []), end]);
          signal?.addEventListener("abort", cancel, { once: true });
        });
      };
      this.lirePageInvisible = async (url, { signal, changerHote: changeHost, ...l }) => {
        this.noter("lirePageInvisible", url, { ...l });
        await wait(url, signal);
        if (l.profil !== null && reading.refuser?.includes(l.profil)) throw new ProfileDenied(l.profil);
        const finalUrl = reading.redirections?.[url] ?? url;
        // Like the real bridge: a redirect to another host waits for `changerHote` before going out.
        const host = new URL(finalUrl).hostname;
        if (changeHost && host !== new URL(url).hostname) {
          this.noter("changerHote", host);
          await changeHost(host);
        }
        const p = reading.pages.find((x) => x.url === finalUrl);
        return p ? structuredClone(p) : { url: finalUrl, titre: "", texte: "", liens: [] };
      };
      this.lireHtmlInvisible = async (url, { signal, ...l }) => {
        this.noter("lireHtmlInvisible", url, { ...l });
        await wait(url, signal);
        return { url, html: reading.html?.[url] ?? "" };
      };
    }
    const widgetData = o.donneesWidget;
    if (widgetData !== undefined) {
      this.demanderDonneesWidget = async (d) => {
        this.noter("demanderDonneesWidget", { ...d });
        return widgetData;
      };
    }
    const giveGrant = o.accorderDev;
    if (giveGrant) {
      this.demanderOutilsDev = async (tab, d) => {
        this.noter("demanderOutilsDev", { ...tab }, d);
        return [...giveGrant];
      };
    }
  }

  /** Tab fields changed (for example the `empreinte` of a site app whose site.json was rewritten). */
  modifierOnglet(id: string, champs: Partial<TabInfo>): void {
    const o = this.onglets.find((x) => x.id === id);
    if (o) Object.assign(o, champs);
  }

  /** The tab (or site app window) closes. */
  fermerOnglet(id: string): void {
    const i = this.onglets.findIndex((x) => x.id === id);
    if (i >= 0) this.onglets.splice(i, 1);
  }

  /** Like the real browser: the host is a domain of the open app or one of their subdomains. */
  adresseSitePermise(site: string, url: string): boolean {
    this.noter("adresseSitePermise", site, url);
    if (!this.onglets.some((x) => x.site === site)) return false;
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") return false;
      host = u.hostname;
    } catch {
      return false;
    }
    return (this.sites[site] ?? []).some((d) => host === d || host.endsWith(`.${d}`));
  }

  /** Lets the suspended reads of this URL finish; returns their number. */
  relacher(url: string): number {
    const list = this.suspendues.get(url) ?? [];
    this.suspendues.delete(url);
    for (const end of list) end();
    return list.length;
  }

  private dev(): FakeDevTools {
    if (!this.outilsDev) throw new Error("PontFactice créé sans outilsDev");
    return this.outilsDev;
  }

  fixerConsole(id: string, messages: MessageConsole[]): void {
    this.dev().consoles.set(id, messages);
  }

  fixerReseau(id: string, requests: NetworkRequest[]): void {
    this.dev().reseaux.set(id, requests);
  }

  /** The user opens their dev tools on the tab. */
  occuper(id: string): void {
    this.dev().occupes.add(id);
  }

  /** The tab moves into a private space (named `espace` if given). */
  rendrePrive(id: string, space?: string): void {
    const o = this.onglets.find((x) => x.id === id);
    if (o && space !== undefined) o.espace = space;
    this.prives.add(id);
  }

  estPrive(id: string): boolean {
    return this.prives.has(id);
  }

  ongletActifPrive(): boolean {
    return this.actif !== null && this.prives.has(this.actif);
  }

  /** The next snapshot has one more « Fuite » object. */
  agrandirTas(): void {
    this.dev().objetsTas += 1;
  }

  private noter(method: string, ...args: unknown[]) {
    this.appels.push({ methode: method, args });
  }

  private trouver(id: string): TabInfo {
    const o = this.onglets.find((x) => x.id === id);
    if (!o) throw new TabNotFound(id);
    if (this.prives.has(id)) throw new PrivateTab(id);
    return o;
  }

  async ongletActif() {
    this.noter("ongletActif");
    return this.onglets.find((x) => x.id === this.actif && !this.prives.has(x.id)) ?? null;
  }

  async listerOnglets() {
    this.noter("listerOnglets");
    return this.onglets.filter((x) => !this.prives.has(x.id)).map((x) => ({ ...x }));
  }

  async lireTexte(id: string) {
    this.noter("lireTexte", id);
    const o = this.trouver(id);
    return { texte: `Texte de ${o.titre} (${o.url})` };
  }

  async ouvrirOnglet(url: string, space?: string) {
    this.noter("ouvrirOnglet", url, space);
    const o = { id: `agent-${++this.compteur}`, titre: url, url, espace: space ?? "perso" };
    this.onglets.push(o);
    this.actif = o.id;
    return { ...o };
  }

  async naviguer(id: string, url: string): Promise<void | "en-attente"> {
    this.noter("naviguer", id, url);
    const o = this.trouver(id);
    if (o.site !== undefined && this.sitesEnAttente.has(o.site)) return "en-attente";
    o.url = url;
  }

  async capturer(id: string) {
    this.noter("capturer", id);
    this.trouver(id);
    return PNG;
  }

  async demanderAutorisation(o: TabInfo) {
    this.noter("demanderAutorisation", o.id);
    return this.autoriser;
  }
}
