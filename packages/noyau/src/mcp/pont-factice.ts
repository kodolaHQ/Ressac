import type { DroitDev } from "../acces/politique.js";
import type { ProfilCpu } from "../outils-dev/resumes.js";
import type { PageLue } from "../workflows/protocole.js";
import {
  OngletIntrouvable,
  OngletPrive,
  OutilsDevOccupes,
  ProfilRefuse,
  type HistoriqueNavigateur,
  type MessageConsole,
  type OngletInfo,
  type PageRetenue,
  type OutilsDevNavigateur,
  type PontNavigateur,
  type RequeteReseau,
  type ResultatHistorique,
  type ResultatJs,
} from "./pont.js";

// PNG 1×1 transparent.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const PROFIL: ProfilCpu = {
  nodes: [
    { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2] },
    { id: 2, callFrame: { functionName: "calculer", url: "http://exemple/app.js", lineNumber: 9 } },
  ],
  samples: [2, 2, 1],
  timeDeltas: [0, 1000, 1000],
  startTime: 0,
  endTime: 3000,
};

/** Un `.heapsnapshot` minimal : `n` objets « Fuite » de 100 octets. */
function tas(n: number): string {
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

/** Attend l'abandon : une opération qui ne se termine jamais d'elle-même. */
const enAttente = <T>(signal: AbortSignal): Promise<T> =>
  new Promise<T>((_, ko) => {
    const rejeter = () => ko(new Error("Interrompu"));
    if (signal.aborted) rejeter();
    else signal.addEventListener("abort", rejeter, { once: true });
  });

/** Outils de développement simulés : tampons fixés par les tests. */
class OutilsDevFactice implements OutilsDevNavigateur {
  readonly consoles = new Map<string, MessageConsole[]>();
  readonly reseaux = new Map<string, RequeteReseau[]>();
  readonly occupes = new Set<string>();
  /** Onglets attachés (comme le rapporte un vrai navigateur). */
  readonly attachesIci = new Set<string>();
  objetsTas = 2;

  constructor(
    private readonly noter: (methode: string, ...args: unknown[]) => void,
    private readonly trouver: (id: string) => OngletInfo,
    private readonly bloquer: boolean,
  ) {}

  private verifier(id: string): void {
    this.trouver(id);
    if (this.occupes.has(id)) throw new OutilsDevOccupes();
  }

  async attacher(id: string) {
    this.noter("attacher", id);
    this.verifier(id);
    this.attachesIci.add(id);
  }

  async detacher(id: string) {
    this.noter("detacher", id);
    this.attachesIci.delete(id);
  }

  attaches(): string[] {
    return [...this.attachesIci];
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

  async corps(id: string, requete: string) {
    this.noter("corps", id, requete);
    this.verifier(id);
    return { corps: `Corps de ${requete}`, base64: false };
  }

  async profiler(id: string, o: { dureeMs?: number; recharger?: boolean }, signal: AbortSignal) {
    this.noter("profiler", id, o);
    this.verifier(id);
    if (this.bloquer) return enAttente<{ profil: ProfilCpu; metriques: Record<string, number> }>(signal);
    return { profil: PROFIL, metriques: { Nodes: 42 } };
  }

  async instantaneMemoire(id: string, signal: AbortSignal) {
    this.noter("instantaneMemoire", id);
    this.verifier(id);
    if (this.bloquer) return enAttente<string>(signal);
    return tas(this.objetsTas);
  }

  async executer(id: string, code: string, _signal: AbortSignal): Promise<ResultatJs> {
    this.noter("executer", id, code);
    this.verifier(id);
    if (code.startsWith("throw ")) return { exception: `${code.slice(6)}\n    at <anonymous>:1:1` };
    return { valeur: JSON.stringify({ code }) };
  }

  async recharger(id: string, sansCache: boolean) {
    this.noter("recharger", id, sansCache);
    this.verifier(id);
  }
}

/** Navigateur simulé : pour les tests et la commande de développement. */
export class PontFactice implements PontNavigateur {
  readonly appels: { methode: string; args: unknown[] }[] = [];
  private readonly onglets: OngletInfo[];
  private actif: string | null;
  private readonly autoriser: boolean;
  private compteur = 0;
  /** Onglets dans un espace privé : invisibles, comme dans le vrai navigateur. */
  private readonly prives = new Set<string>();
  readonly outilsDev?: OutilsDevFactice;
  readonly historique?: HistoriqueNavigateur;
  lirePageInvisible?: (url: string, o: { profil: string | null; domaines?: string[]; adressesLocales?: boolean }) => Promise<PageLue>;
  demanderDonneesWidget?: (o: { id: string; nom: string; agent: string }, signal?: AbortSignal) => Promise<boolean>;
  demanderOutilsDev?: (o: OngletInfo, d: { droits: DroitDev[]; raison: string; agent: string }, signal?: AbortSignal) => Promise<DroitDev[]>;

  /**
   * `outilsDev` fournit les outils de développement simulés ; `accorderDev` fournit aussi la carte de consentement,
   * qui répond ces droits. `bloquer` : profils et instantanés ne finissent qu'à l'abandon. `historique` fournit
   * l'historique : `chercher` renvoie `resultats` (au plus `limite`), `lire` la page de `textes` à cette URL, et
   * `erreur`, si donnée, fait échouer les deux. `lecture` fournit `lirePageInvisible` : la page de `pages` à cette URL
   * (sinon une page vide), et ProfilRefuse pour un profil de `refuser`. `redirections` simule une redirection :
   * l'URL demandée mène à l'URL associée, et c'est cette page-là qui est rendue. `donneesWidget` fournit la carte
   * « donnees-widget », qui répond cette valeur.
   */
  constructor(
    onglets: OngletInfo[],
    o: {
      actif: string | null;
      autoriser: boolean;
      outilsDev?: boolean;
      accorderDev?: DroitDev[];
      bloquer?: boolean;
      historique?: { resultats: ResultatHistorique[]; textes?: PageRetenue[]; erreur?: string };
      lecture?: { pages: PageLue[]; refuser?: string[]; redirections?: Record<string, string> };
      donneesWidget?: boolean;
    },
  ) {
    this.onglets = onglets.map((x) => ({ ...x }));
    this.actif = o.actif;
    this.autoriser = o.autoriser;
    if (o.outilsDev || o.accorderDev) {
      this.outilsDev = new OutilsDevFactice((m, ...a) => this.noter(m, ...a), (id) => this.trouver(id), o.bloquer ?? false);
    }
    const h = o.historique;
    if (h) {
      const echouer = () => {
        if (h.erreur) throw new Error(h.erreur);
      };
      this.historique = {
        chercher: async (q) => {
          this.noter("chercherHistorique", { ...q });
          echouer();
          return h.resultats.slice(0, q.limite).map((r) => ({ ...r }));
        },
        lire: async (url) => {
          this.noter("lireHistorique", url);
          echouer();
          const p = h.textes?.find((x) => x.url === url);
          return p ? { ...p } : null;
        },
      };
    }
    const lecture = o.lecture;
    if (lecture) {
      this.lirePageInvisible = async (url, l) => {
        this.noter("lirePageInvisible", url, { ...l });
        if (l.profil !== null && lecture.refuser?.includes(l.profil)) throw new ProfilRefuse(l.profil);
        const finale = lecture.redirections?.[url] ?? url;
        const p = lecture.pages.find((x) => x.url === finale);
        return p ? structuredClone(p) : { url: finale, titre: "", texte: "", liens: [] };
      };
    }
    const donneesWidget = o.donneesWidget;
    if (donneesWidget !== undefined) {
      this.demanderDonneesWidget = async (d) => {
        this.noter("demanderDonneesWidget", { ...d });
        return donneesWidget;
      };
    }
    const accorder = o.accorderDev;
    if (accorder) {
      this.demanderOutilsDev = async (onglet, d) => {
        this.noter("demanderOutilsDev", { ...onglet }, d);
        return [...accorder];
      };
    }
  }

  private dev(): OutilsDevFactice {
    if (!this.outilsDev) throw new Error("PontFactice créé sans outilsDev");
    return this.outilsDev;
  }

  fixerConsole(id: string, messages: MessageConsole[]): void {
    this.dev().consoles.set(id, messages);
  }

  fixerReseau(id: string, requetes: RequeteReseau[]): void {
    this.dev().reseaux.set(id, requetes);
  }

  /** L'utilisateur ouvre ses outils de développement sur l'onglet. */
  occuper(id: string): void {
    this.dev().occupes.add(id);
  }

  /** L'onglet passe dans un espace privé (nommé `espace` si donné). */
  rendrePrive(id: string, espace?: string): void {
    const o = this.onglets.find((x) => x.id === id);
    if (o && espace !== undefined) o.espace = espace;
    this.prives.add(id);
  }

  estPrive(id: string): boolean {
    return this.prives.has(id);
  }

  ongletActifPrive(): boolean {
    return this.actif !== null && this.prives.has(this.actif);
  }

  /** Le prochain instantané compte un objet « Fuite » de plus. */
  agrandirTas(): void {
    this.dev().objetsTas += 1;
  }

  private noter(methode: string, ...args: unknown[]) {
    this.appels.push({ methode, args });
  }

  private trouver(id: string): OngletInfo {
    const o = this.onglets.find((x) => x.id === id);
    if (!o) throw new OngletIntrouvable(id);
    if (this.prives.has(id)) throw new OngletPrive(id);
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

  async ouvrirOnglet(url: string, espace?: string) {
    this.noter("ouvrirOnglet", url, espace);
    const o = { id: `agent-${++this.compteur}`, titre: url, url, espace: espace ?? "perso" };
    this.onglets.push(o);
    this.actif = o.id;
    return { ...o };
  }

  async naviguer(id: string, url: string) {
    this.noter("naviguer", id, url);
    this.trouver(id).url = url;
  }

  async capturer(id: string) {
    this.noter("capturer", id);
    this.trouver(id);
    return PNG;
  }

  async demanderAutorisation(o: OngletInfo) {
    this.noter("demanderAutorisation", o.id);
    return this.autoriser;
  }
}
