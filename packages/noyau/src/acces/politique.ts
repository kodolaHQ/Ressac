import type { OngletInfo } from "../mcp/pont.js";

function origine(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/** Les démos de l'agent tournent dans le conteneur et s'ouvrent en local. */
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

/** Ports des démos de l'agent par défaut (5280–5299). */
const portDemo = (port: number): boolean => port >= 5280 && port <= 5299;

/**
 * Ce que l'agent a le droit de lire (spec §8.2) : un onglet que l'utilisateur lui a donné, depuis lequel
 * il lui a parlé, ou une démo locale que l'agent a ouverte lui-même. Un site extérieur ouvert par
 * l'agent (Gmail, sa banque…) reste soumis à demande. Une autorisation vaut pour un site (origine) :
 * si l'utilisateur change de site, elle tombe.
 */
export class PolitiqueAcces {
  /** id d'onglet → origine autorisée */
  private readonly autorisations = new Map<string, string>();
  /** id d'onglet → origine où l'agent a construit ce qu'il montre */
  private readonly construites = new Map<string, string>();
  /** id d'onglet → droits accordés par l'utilisateur, valables pour une origine */
  private readonly droits = new Map<string, { origine: string; liste: Set<DroitDev> }>();
  /** id d'onglet → droits refusés, non redemandables avant le prochain message de l'utilisateur */
  private readonly refus = new Map<string, Set<DroitDev>>();
  /** id d'onglet → droits coupés (une construite le reste jusqu'à la prochaine conversation) */
  private readonly coupes = new Map<string, Set<DroitDev>>();
  /**
   * Droits coupés sur ce que l'agent a construit, par fenêtre d'appli (`app:<dossier>`) et par origine : ils survivent
   * à la fermeture de l'onglet, pour que l'agent ne retrouve pas ses droits en relançant l'appli ou en rouvrant sa démo.
   */
  private readonly coupesConstruites = new Map<string, Set<DroitDev>>();
  /** id d'onglet → nombre d'outils en cours */
  private readonly utilisations = new Map<string, number>();
  /** Widgets avec compte dont l'utilisateur a montré les données à l'agent (carte « donnees-widget »), pour cette conversation. */
  private readonly donneesWidgets = new Set<string>();
  /**
   * Applis de site que l'utilisateur a ouvertes à l'agent (pages et mémoire), pour cette conversation, et l'empreinte de leur
   * déclaration au moment de la carte (`empreinteLectureSite` ; null si le navigateur n'en donne pas).
   */
  private readonly sitesLus = new Map<string, string | null>();
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

  /** Numéro de la conversation en cours : change à chaque `reinitialiser()`. Une réponse d'une conversation passée ne vaut rien. */
  get conversation(): number {
    return this.numeroConversation;
  }

  /** Abonnement aux changements ; renvoie le désabonnement. */
  surChange(rappel: () => void): () => void {
    this.ecouteurs.add(rappel);
    return () => void this.ecouteurs.delete(rappel);
  }

  /** Marque l'onglet comme construit par l'agent (fenêtre d'application, ou démo locale sur un port de l'agent). */
  construite(o: OngletInfo): void {
    const org = origine(o.url);
    // Une appli de site n'est jamais ce que l'agent a construit (pas de droits d'office), même servie en local.
    if (!org || o.site !== undefined || !(o.application || this.qualifie(o.url))) return;
    if (this.construites.get(o.id) === org) return;
    this.construites.set(o.id, org);
    this.change();
  }

  estConstruite(o: OngletInfo): boolean {
    const org = origine(o.url);
    return org !== null && this.construites.get(o.id) === org;
  }

  /** Clés sous lesquelles une coupe d'une construite est retenue : la fenêtre d'appli, et l'origine. */
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

  /** Droits d'outils de développement valables maintenant pour cet onglet ; aucun sur une appli de site sans son accord. */
  droitsDev(o: OngletInfo): DroitDev[] {
    if (o.site !== undefined && !this.lectureSiteAccordee(o.site, o.empreinte)) return [];
    return this.droitsDe(o.id, origine(o.url), this.estConstruite(o));
  }

  /** L'utilisateur a coché `accordes` et laissé `refuses` : ces derniers ne sont plus demandables d'ici son prochain message. */
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

  /** Coupe un droit, ou tout (lecture comprise) si `d` est absent. */
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

  /** Un outil démarre (`true`) ou se termine (`false`) sur l'onglet : sert au battement de l'indicateur. */
  utilisation(id: string, actif: boolean): void {
    const n = Math.max(0, (this.utilisations.get(id) ?? 0) + (actif ? 1 : -1));
    if (n) this.utilisations.set(id, n);
    else this.utilisations.delete(id);
    this.change();
  }

  /** Onglets sur lesquels l'agent a la lecture, un droit, ou un outil en cours. */
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
    // La fenêtre d'une appli de site ne s'ouvre que par l'accord de l'appli (accorderLectureSite), jamais par une origine.
    if (o.site !== undefined) return false;
    const org = origine(o.url);
    if (!org || this.autorisations.get(o.id) === org) return false;
    this.autorisations.set(o.id, org);
    return true;
  }

  /** L'utilisateur a autorisé la lecture : la pastille suit. */
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

  /** L'agent a navigué lui-même un onglet auquel il avait accès : l'accès suit sur le même site ou vers une démo locale. */
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

  /** Les droits de développement et la marque « construite » ne survivent pas à un changement d'origine. */
  private quitterOrigine(id: string, org: string | null): void {
    if (this.droits.get(id)?.origine !== org) this.droits.delete(id);
    if (this.construites.get(id) !== org) this.construites.delete(id);
  }

  /** Navigation faite par l'utilisateur : changer de site retire l'autorisation. */
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
   * Une appli de site (`o.site`) se lit seulement avec son accord, quelle que soit l'origine de sa page : une
   * autorisation donnée à un onglet du même domaine ne l'ouvre pas.
   */
  peutLire(o: OngletInfo): boolean {
    if (o.site !== undefined) return this.lectureSiteAccordee(o.site, o.empreinte);
    const org = origine(o.url);
    return org !== null && this.autorisations.get(o.id) === org;
  }

  /** L'utilisateur montre à l'agent les données de ce widget avec compte, jusqu'à la prochaine conversation. */
  accorderDonneesWidget(id: string): void {
    this.donneesWidgets.add(id);
    this.change();
  }

  donneesWidgetAccordees(id: string): boolean {
    return this.donneesWidgets.has(id);
  }

  /** Comme pour un widget, avec une clé à part : accorder les résultats d'une action n'accorde pas ceux d'un widget du même nom. */
  accorderDonneesAction(id: string): void {
    this.donneesWidgets.add(`action:${id}`);
    this.change();
  }

  donneesActionAccordees(id: string): boolean {
    return this.donneesWidgets.has(`action:${id}`);
  }

  /**
   * L'utilisateur ouvre l'appli de site `id` à l'agent (ses pages et sa mémoire), jusqu'à la prochaine conversation, telle que
   * la carte la montrait (`empreinte` de sa déclaration) : une autre empreinte ensuite ne compte pas.
   */
  accorderLectureSite(id: string, empreinte?: string): void {
    const e = empreinte ?? null;
    if (this.sitesLus.has(id) && this.sitesLus.get(id) === e) return;
    this.sitesLus.set(id, e);
    this.change();
  }

  /** L'accord de lecture de l'appli tient-il, pour la déclaration d'empreinte `empreinte` (celle d'aujourd'hui) ? */
  lectureSiteAccordee(id: string, empreinte?: string): boolean {
    return this.sitesLus.has(id) && this.sitesLus.get(id) === (empreinte ?? null);
  }

  /** L'appli de site est supprimée : son accord de lecture tombe (une appli recréée au même id redemande la carte). */
  retirerLectureSite(id: string): void {
    if (this.sitesLus.delete(id)) this.change();
  }

  /** Nouvelle conversation : plus aucune autorisation, refus ni coupe. Les « construites » restent : elles tiennent à l'onglet. */
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
