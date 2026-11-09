import type { OngletInfo } from "../mcp/pont.js";
import { plagePortsConteneur } from "../conteneur/atelier.js";

function origine(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/** The agent's demos run in the container and open locally. */
function estLocale(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export type DroitDev = "console" | "reseau" | "performances" | "agir";
export const DROITS_DEV: readonly DroitDev[] = ["console", "reseau", "performances", "agir"];

export interface EtatAccesOnglet {
  lecture: boolean;
  droits: DroitDev[];
  construite: boolean;
  enCours: boolean;
}

/** Default ports of the agent's demos: those of the container. */
const portDemo = (port: number): boolean => {
  const [min, max] = plagePortsConteneur();
  return port >= min && port <= max;
};

/**
 * What the agent may read (spec §8.2): a tab the user gave it, from which the user
 * spoke to it, or a local demo the agent opened itself. An outside site opened by
 * the agent (Gmail, its bank…) still needs a request. A permission holds for one site (origin):
 * if the user changes site, it lapses.
 */
export class PolitiqueAcces {
  /** tab id → authorized origin */
  private readonly autorisations = new Map<string, string>();
  /** tab id → origin where the agent built what it shows */
  private readonly construites = new Map<string, string>();
  /** tab id → rights granted by the user, valid for one origin */
  private readonly droits = new Map<string, { origine: string; liste: Set<DroitDev> }>();
  /** tab id → rights denied, not askable again before the user's next message */
  private readonly refus = new Map<string, Set<DroitDev>>();
  /** tab id → rights cut (a built one stays cut until the next conversation) */
  private readonly coupes = new Map<string, Set<DroitDev>>();
  /**
   * Rights cut on what the agent built, by app window (`app:<folder>`) and by origin: they survive
   * the tab closing, so the agent does not get its rights back by relaunching the app or reopening its demo.
   */
  private readonly coupesConstruites = new Map<string, Set<DroitDev>>();
  /** tab id → number of tools running */
  private readonly utilisations = new Map<string, number>();
  /** Widgets with an account whose data the user showed the agent (card « donnees-widget »), for this conversation. */
  private readonly donneesWidgets = new Set<string>();
  /**
   * Site apps the user opened to the agent (pages and memory), for this conversation, and the hash of their
   * declaration when the card was shown (`empreinteLectureSite`; null if the browser gives none).
   */
  private readonly sitesLus = new Map<string, string | null>();
  /** Withdrawals of the read grant per app (deletions): a card posted before one of them grants nothing. */
  private readonly retraitsSites = new Map<string, number>();
  private readonly ecouteurs = new Set<() => void>();
  private numeroConversation = 0;
  private readonly portConstruit: (port: number) => boolean;

  constructor(o: { portConstruit?: (port: number) => boolean } = {}) {
    this.portConstruit = o.portConstruit ?? portDemo;
  }

  private change(): void {
    for (const rappel of [...this.ecouteurs]) rappel();
  }

  private qualifie(url: string): boolean {
    if (!estLocale(url)) return false;
    const port = Number(new URL(url).port);
    return port > 0 && this.portConstruit(port);
  }

  private ajouter<T>(m: Map<string, Set<T>>, id: string, v: T): void {
    const s = m.get(id) ?? new Set<T>();
    s.add(v);
    m.set(id, s);
  }

  private oublier(id: string): void {
    this.autorisations.delete(id);
    this.construites.delete(id);
    this.droits.delete(id);
    this.refus.delete(id);
    this.coupes.delete(id);
    this.utilisations.delete(id);
  }

  /** Number of the current conversation: changes on every `reinitialiser()`. A reply from a past conversation is worth nothing. */
  get conversation(): number {
    return this.numeroConversation;
  }

  /** Subscription to changes; returns the unsubscribe. */
  surChange(rappel: () => void): () => void {
    this.ecouteurs.add(rappel);
    return () => void this.ecouteurs.delete(rappel);
  }

  /** Marks the tab as built by the agent (app window, or local demo on an agent port). */
  construite(o: OngletInfo): void {
    const org = origine(o.url);
    // A site app is never what the agent built (no rights by default), even served locally.
    if (!org || o.site !== undefined || !(o.application || this.qualifie(o.url))) return;
    if (this.construites.get(o.id) === org) return;
    this.construites.set(o.id, org);
    this.change();
  }

  estConstruite(o: OngletInfo): boolean {
    const org = origine(o.url);
    return org !== null && this.construites.get(o.id) === org;
  }

  /** Keys under which a cut on a built one is kept: the app window, and the origin. */
  private clesConstruite(id: string, org: string): string[] {
    return id.startsWith("app:") ? [id, org] : [org];
  }

  private coupeConstruite(id: string, org: string, d: DroitDev): boolean {
    return this.coupes.get(id)?.has(d) === true || this.clesConstruite(id, org).some((c) => this.coupesConstruites.get(c)?.has(d));
  }

  private droitsDe(id: string, org: string | null, construite: boolean): DroitDev[] {
    if (!org) return [];
    const accordes = this.droits.get(id);
    return DROITS_DEV.filter(
      (d) => (accordes?.origine === org && accordes.liste.has(d)) || (construite && !this.coupeConstruite(id, org, d)),
    );
  }

  /** Development tool rights valid now for this tab; none on a site app without its grant. */
  droitsDev(o: OngletInfo): DroitDev[] {
    if (o.site !== undefined && !this.lectureSiteAccordee(o.site, o.empreinte)) return [];
    return this.droitsDe(o.id, origine(o.url), this.estConstruite(o));
  }

  /** The user ticked `accordes` and left `refuses`: the latter are no longer askable until the user's next message. */
  accorderDev(o: OngletInfo, accordes: DroitDev[], refuses: DroitDev[]): void {
    const org = origine(o.url);
    if (org) {
      const actuel = this.droits.get(o.id);
      const liste = actuel?.origine === org ? actuel.liste : new Set<DroitDev>();
      for (const d of accordes) {
        liste.add(d);
        this.coupes.get(o.id)?.delete(d);
        for (const c of this.clesConstruite(o.id, org)) this.coupesConstruites.get(c)?.delete(d);
      }
      this.droits.set(o.id, { origine: org, liste });
    }
    for (const d of refuses) this.ajouter(this.refus, o.id, d);
    this.change();
  }

  peutDemander(id: string, d: DroitDev): boolean {
    return !this.refus.get(id)?.has(d);
  }

  /** Cuts one right, or all (read included) if `d` is absent. */
  couper(id: string, d?: DroitDev): void {
    const cibles = d ? [d] : DROITS_DEV;
    const construite = this.construites.get(id);
    for (const c of cibles) {
      this.droits.get(id)?.liste.delete(c);
      this.ajouter(this.coupes, id, c);
      if (construite) for (const cle of this.clesConstruite(id, construite)) this.ajouter(this.coupesConstruites, cle, c);
    }
    if (!d) this.autorisations.delete(id);
    this.change();
  }

  /** A tool starts (`true`) or ends (`false`) on the tab: drives the indicator's pulse. */
  utilisation(id: string, actif: boolean): void {
    const n = Math.max(0, (this.utilisations.get(id) ?? 0) + (actif ? 1 : -1));
    if (n) this.utilisations.set(id, n);
    else this.utilisations.delete(id);
    this.change();
  }

  /** Tabs on which the agent has read access, a right, or a running tool. */
  etat(): Record<string, EtatAccesOnglet> {
    const ids = new Set([...this.autorisations.keys(), ...this.construites.keys(), ...this.droits.keys(), ...this.utilisations.keys()]);
    const r: Record<string, EtatAccesOnglet> = {};
    for (const id of ids) {
      const construite = this.construites.has(id);
      const lecture = this.autorisations.has(id);
      const droits = this.droitsDe(id, this.droits.get(id)?.origine ?? this.construites.get(id) ?? null, construite);
      const enCours = this.utilisations.has(id);
      if (lecture || droits.length || enCours) r[id] = { lecture, droits, construite, enCours };
    }
    return r;
  }

  private autoriser(o: OngletInfo): boolean {
    // A site app window only opens through the app's grant (accorderLectureSite), never through an origin.
    if (o.site !== undefined) return false;
    const org = origine(o.url);
    if (!org || this.autorisations.get(o.id) === org) return false;
    this.autorisations.set(o.id, org);
    return true;
  }

  /** The user authorized reading: the badge follows. */
  accorder(o: OngletInfo): void {
    if (this.autoriser(o)) this.change();
  }

  interactionUtilisateur(o: OngletInfo): void {
    this.refus.clear();
    this.autoriser(o);
    this.change();
  }

  ongletOuvertParAgent(o: OngletInfo): void {
    if (estLocale(o.url)) this.autoriser(o);
    this.construite(o);
    this.change();
  }

  /** The agent navigated a tab it had access to itself: access follows on the same site or to a local demo. */
  navigationParAgent(id: string, url: string): void {
    const org = origine(url);
    this.quitterOrigine(id, org);
    if (org && this.qualifie(url)) this.construites.set(id, org);
    if (this.autorisations.has(id)) {
      if (org && (org === this.autorisations.get(id) || estLocale(url))) this.autorisations.set(id, org);
      else this.autorisations.delete(id);
    }
    this.change();
  }

  /** Development rights and the « built » mark do not survive an origin change. */
  private quitterOrigine(id: string, org: string | null): void {
    if (this.droits.get(id)?.origine !== org) this.droits.delete(id);
    if (this.construites.get(id) !== org) this.construites.delete(id);
  }

  /** Navigation done by the user: changing site removes the authorization. */
  ongletNavigue(id: string, url: string): void {
    const org = origine(url);
    if (this.autorisations.get(id) !== org) this.autorisations.delete(id);
    this.quitterOrigine(id, org);
    this.change();
  }

  ongletFerme(id: string): void {
    this.oublier(id);
    this.change();
  }

  /**
   * A site app (`o.site`) is read only with its grant, whatever the origin of its page: an
   * authorization given to a tab of the same domain does not open it.
   */
  peutLire(o: OngletInfo): boolean {
    if (o.site !== undefined) return this.lectureSiteAccordee(o.site, o.empreinte);
    const org = origine(o.url);
    return org !== null && this.autorisations.get(o.id) === org;
  }

  /** The user shows the agent the data of this widget with an account, until the next conversation. */
  accorderDonneesWidget(id: string): void {
    this.donneesWidgets.add(id);
    this.change();
  }

  donneesWidgetAccordees(id: string): boolean {
    return this.donneesWidgets.has(id);
  }

  /** As for a widget, with a separate key: granting an action's results does not grant those of a widget of the same name. */
  accorderDonneesAction(id: string): void {
    this.donneesWidgets.add(`action:${id}`);
    this.change();
  }

  donneesActionAccordees(id: string): boolean {
    return this.donneesWidgets.has(`action:${id}`);
  }

  /**
   * The user opens the site app `id` to the agent (its pages and memory), until the next conversation, as
   * the card showed it (`empreinte` of its declaration): a different hash afterwards does not count.
   */
  accorderLectureSite(id: string, empreinte?: string): void {
    const e = empreinte ?? null;
    if (this.sitesLus.has(id) && this.sitesLus.get(id) === e) return;
    this.sitesLus.set(id, e);
    this.change();
  }

  /** Does the app's read grant hold, for the declaration hash `empreinte` (today's)? */
  lectureSiteAccordee(id: string, empreinte?: string): boolean {
    return this.sitesLus.has(id) && this.sitesLus.get(id) === (empreinte ?? null);
  }

  /**
   * The site app is deleted: its read grant lapses, and its cards still pending (all conversations)
   * are withdrawn and count as denials. An app recreated with the same id asks for the card again.
   */
  retirerLectureSite(id: string): void {
    this.sitesLus.delete(id);
    this.retraitsSites.set(id, this.retraitsLectureSite(id) + 1);
    this.change();
  }

  /** Number of withdrawals of the app's read grant: a card reads it when posted. */
  retraitsLectureSite(id: string): number {
    return this.retraitsSites.get(id) ?? 0;
  }

  /** New conversation: no more authorizations, denials or cuts. The « built » ones stay: they belong to the tab. */
  reinitialiser(): void {
    this.autorisations.clear();
    this.droits.clear();
    this.refus.clear();
    this.coupes.clear();
    this.coupesConstruites.clear();
    this.donneesWidgets.clear();
    this.sitesLus.clear();
    this.numeroConversation++;
    this.change();
  }
}
