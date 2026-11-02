import type { Session, WebContents } from "electron";
import { navigationHorsSite, OngletIntrouvable, OngletPrive, type DroitDev, type HistoriqueNavigateur, type OngletInfo, type OptionsLecturePage, type OutilsDevNavigateur, type PageLue, type PontNavigateur } from "@webaios/noyau";
import { ongletPrive, type Decision, type DemandeEnAttente, type Issue, type EtatFenetre, type EtatNavigateur, type IdEspace, type IdFenetre, type Onglet } from "../../commun/modele";
import { memeOrigine } from "../applications/favicon";
import type { Historique } from "../historique";
import type { Magasin } from "../ipc";
import { InspecteurCdp } from "../outils-dev/inspecteur";
import { lireHtmlInvisible, lirePageInvisible } from "./lecture-invisible";

const info = (etat: EtatNavigateur, o: Onglet): OngletInfo => ({
  id: o.id,
  titre: o.titre,
  url: o.url,
  espace: etat.espaces.find((e) => e.id === o.espaceId)?.nom ?? "",
});

/** Pages internes de WebAiOs (`webaios:`) : l'agent ne les voit jamais. */
const interne = (o: Onglet) => o.url.startsWith("webaios:");

/** L'agent voit l'onglet : ni page interne, ni onglet d'un espace privé (spec §3.3). */
const visible = (etat: EtatNavigateur, o: Onglet) => !interne(o) && !ongletPrive(etat, o);

/** Tous les onglets, toutes fenêtres confondues, tels que l'agent les voit. */
export function infosOnglets(etat: EtatNavigateur): OngletInfo[] {
  return Object.values(etat.onglets).filter((o) => visible(etat, o)).map((o) => info(etat, o));
}

/** L'onglet que l'utilisateur regarde dans la fenêtre, page interne comprise. */
function ongletAffiche(etat: EtatNavigateur, fenetreId: IdFenetre | undefined): Onglet | undefined {
  const f = etat.fenetres.find((x) => x.id === fenetreId);
  const id = f?.actif[f.espaceActif];
  return id ? etat.onglets[id] : undefined;
}

export function ongletActifDe(etat: EtatNavigateur, fenetreId: IdFenetre | undefined): OngletInfo | null {
  const o = ongletAffiche(etat, fenetreId);
  return o && visible(etat, o) ? info(etat, o) : null;
}

/** L'espace demandé par l'agent : par id, puis par nom (sans casse), sinon l'espace actif. Un espace privé compte comme inconnu. */
export function resoudreEspace(etat: EtatNavigateur, f: EtatFenetre, espace?: string): IdEspace {
  if (!espace) return f.espaceActif;
  const ouverts = etat.espaces.filter((x) => !x.prive);
  const e = ouverts.find((x) => x.id === espace) ?? ouverts.find((x) => x.nom.toLowerCase() === espace.toLowerCase());
  return e?.id ?? f.espaceActif;
}

/**
 * Ce que la politique d'accès doit apprendre d'un changement d'état : navigations et fermetures. Un onglet passé dans
 * un espace privé est fermé pour l'agent : lecture et outils de développement tombent.
 */
export function changementsPolitique(avant: EtatNavigateur, apres: EtatNavigateur): { navigues: { id: string; url: string }[]; fermes: string[] } {
  const navigues: { id: string; url: string }[] = [];
  const fermes: string[] = [];
  for (const [id, o] of Object.entries(avant.onglets)) {
    const n = apres.onglets[id];
    if (!n || (!ongletPrive(avant, o) && ongletPrive(apres, n))) fermes.push(id);
    else if (n.url !== o.url) navigues.push({ id, url: n.url });
  }
  return { navigues, fermes };
}

/** Les espaces qui viennent de passer de non privé à privé (le sens inverse ne change rien à l'historique). */
export function espacesDevenusPrives(avant: EtatNavigateur, apres: EtatNavigateur): string[] {
  return apres.espaces.filter((n) => n.prive && avant.espaces.some((o) => o.id === n.id && !o.prive)).map((n) => n.id);
}

/**
 * Une question qui ne recevra plus de réponse utile : son onglet visé est fermé. Une demande de l'agent s'affiche
 * dans sa fenêtre, quel que soit l'onglet affiché : fermer celui-ci ne la concerne pas.
 */
export function questionCaduque(d: DemandeEnAttente, etat: EtatNavigateur): boolean {
  // Carte d'accord d'une extension : elle tombe avec son espace ; celle de l'agent aussi quand le profil de l'espace
  // devient privé (aucune extension de l'agent n'y est chargée). Retrait du registre et coupure : ServiceExtensions.
  if (d.extension) {
    const espace = etat.espaces.find((e) => e.id === d.extension!.espaceId);
    if (!espace) return true;
    if (d.extension.source === "agent" && etat.espaces.some((e) => e.profil === espace.profil && e.prive)) return true;
  }
  // Une fenêtre d'appli (`app:<dossier>`) ou d'appli de site (`site:<id>`) n'est pas un onglet : sa fermeture et ses
  // navigations sont suivies à part.
  const fenetre = d.cible !== undefined && (d.cible.startsWith(PREFIXE_APP) || d.cible.startsWith(PREFIXE_SITE));
  const onglet = d.cible && !fenetre ? etat.onglets[d.cible] : undefined;
  if (d.cible && !fenetre && !onglet) return true;
  // Passé dans un espace privé : l'agent n'y a plus accès, la question n'a plus d'objet.
  if (onglet && ongletPrive(etat, onglet)) return true;
  // Les droits portent sur le site que l'utilisateur a vu : l'onglet est parti ailleurs, la carte tombe.
  if (onglet && d.permissions.includes("outils-dev") && origineDe(onglet.url) !== d.origine) return true;
  return !d.fenetreId && d.ongletId !== null && !etat.onglets[d.ongletId];
}

/**
 * La décision retenue pour une réponse de l'interface : un « oui » à une carte d'extension renforcée n'est reçu que s'il
 * porte la case « Je comprends » cochée (`confirme`) ; sinon c'est un refus, quel que soit ce qu'affiche l'interface.
 */
export function decisionPermise(d: DemandeEnAttente, decision: Decision, confirme?: boolean): Decision {
  if (decision === "autoriser" && d.extension?.renforce && confirme !== true) return "refuser";
  return decision;
}

/** L'origine d'une URL, ou l'URL telle quelle si elle n'en a pas. */
export function origineDe(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Une demande de lecture sans réponse au bout de ce délai est refusée : l'agent ne reste pas bloqué. */
export const DELAI_QUESTION_MS = 120_000;

/**
 * Pose une question à l'utilisateur et attend sa réponse. `poser` affiche la question, reçoit de quoi y répondre, et
 * renvoie de quoi la retirer (appelé si le délai expire, ou si `signal` est levé : la réponse est alors un refus).
 * `delaiMs` vaut `Infinity` pour une question sans délai.
 */
export function attendreReponse(
  poser: (repondre: (d: Issue) => void) => () => void,
  delaiMs = DELAI_QUESTION_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  return attendreIssue(poser, delaiMs, signal).then((d) => d === "autoriser");
}

/**
 * Comme `attendreReponse`, mais dit si la question est tombée sans réponse de l'utilisateur (« retiree » : délai, `signal`,
 * ou retirée par celui qui l'a posée).
 */
export function attendreIssue(
  poser: (repondre: (d: Issue) => void) => () => void,
  delaiMs = DELAI_QUESTION_MS,
  signal?: AbortSignal,
): Promise<Issue> {
  if (signal?.aborted) return Promise.resolve("retiree");
  return new Promise((ok) => {
    let finie = false;
    const repondre = (d: Issue) => {
      if (finie) return;
      finie = true;
      clearTimeout(minuterie);
      signal?.removeEventListener("abort", abandon);
      ok(d);
    };
    const abandon = () => {
      if (finie) return;
      retirer();
      repondre("retiree");
    };
    // `Infinity` : aucun délai (une question venue d'un clic de l'utilisateur attend sa réponse).
    const minuterie = Number.isFinite(delaiMs) ? setTimeout(abandon, delaiMs) : undefined;
    const retirer = poser(repondre);
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

/**
 * Comme `attendreReponse`, pour la carte des outils de développement : renvoie les droits cochés si l'utilisateur autorise,
 * `[]` s'il refuse, si le délai expire ou si `signal` est levé (la carte est alors retirée).
 */
export function attendreDroits(
  poser: (repondre: (d: Issue, droits?: DroitDev[]) => void) => () => void,
  delaiMs = DELAI_QUESTION_MS,
  signal?: AbortSignal,
): Promise<DroitDev[]> {
  if (signal?.aborted) return Promise.resolve([]);
  return new Promise((ok) => {
    let finie = false;
    const repondre = (d: Issue, droits: DroitDev[] = []) => {
      if (finie) return;
      finie = true;
      clearTimeout(minuterie);
      signal?.removeEventListener("abort", abandon);
      ok(d === "autoriser" ? droits : []);
    };
    const abandon = () => {
      if (finie) return;
      retirer();
      repondre("refuser");
    };
    const minuterie = setTimeout(abandon, delaiMs);
    const retirer = poser(repondre);
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

/** Ce que le pont demande aux vues (GestionnaireVues). */
export interface VuesPourAgent {
  naviguer(id: string, url: string): void;
  lireTexte(o: Onglet): Promise<{ texte: string; selection?: string }>;
  capturer(o: Onglet): Promise<Buffer>;
  lireTexteDe(wc: WebContents): Promise<{ texte: string; selection?: string }>;
  capturerDe(wc: WebContents): Promise<Buffer>;
  /** La page de l'onglet, s'il en a une (un onglet jamais affiché n'en a pas). */
  vue(id: string): WebContents | null;
}

/** Les fenêtres des applications lancées, vues comme des onglets `app:<dossier>`. */
export interface FenetresPourAgent {
  ouvertes(): { dossier: string; titre: string; url: string }[];
  webContents(dossier: string): WebContents | undefined;
}

const PREFIXE_APP = "app:";
/** Id d'onglet, pour l'agent, de la fenêtre d'une appli de site : `site:<id>`. */
export const PREFIXE_SITE = "site:";

/**
 * Les fenêtres des applis de site ouvertes, vues comme des onglets `site:<id>`. `webContents` est la vue du site
 * (`vueSite`), jamais l'interface de la fenêtre (barre, carte d'accord, accueil) ni une autre fenêtre.
 */
export interface FenetresSitesPourAgent {
  ouvertes(): { id: string; nom: string; url: string }[];
  webContents(id: string): WebContents | undefined;
  adressePermise(id: string, url: string): boolean;
  /** Charge l'adresse comme un chargement voulu par WebAiOs (`FenetresSites.naviguerPourAgent`) ; faux si refusée. */
  naviguer(id: string, url: string): boolean;
}

/** La fenêtre d'une appli de site vue comme un onglet `site:<id>` : son titre est le nom de l'appli, jamais celui de la page. */
export function ongletSite(s: { id: string; nom: string; url: string }): OngletInfo {
  return { id: PREFIXE_SITE + s.id, titre: s.nom, url: s.url, espace: "", site: s.id };
}

/** La fenêtre d'une appli vue comme un onglet `app:<dossier>` par l'agent. */
export function ongletApplication(a: { dossier: string; titre: string; url: string }): OngletInfo {
  return { id: PREFIXE_APP + a.dossier, titre: a.titre, url: a.url, espace: "", application: a.dossier };
}

/** Le navigateur Electron vu par le noyau (spec §5) : lire, ouvrir, capturer les onglets ; demander à l'utilisateur. */
export class PontElectron implements PontNavigateur {
  /** Outils de développement de l'agent, par le débogueur de la page de l'onglet ou de la fenêtre d'appli. */
  readonly outilsDev: OutilsDevNavigateur = new InspecteurCdp((id) => {
    if (id.startsWith(PREFIXE_APP)) return this.o.applications.webContents(id.slice(PREFIXE_APP.length));
    // La vue du site seulement : ni l'interface de sa fenêtre (barre, carte, accueil), ni une autre fenêtre.
    if (id.startsWith(PREFIXE_SITE)) return this.o.sites?.webContents(id.slice(PREFIXE_SITE.length));
    const etat = this.o.magasin.etat;
    const o = etat.onglets[id];
    return o && !ongletPrive(etat, o) ? (this.o.vues.vue(id) ?? undefined) : undefined;
  });

  /** L'historique pour l'agent : les seules visites non privées (voir Historique.rechercherPourAgent). */
  readonly historique?: HistoriqueNavigateur;

  constructor(
    private readonly o: {
      magasin: Magasin;
      vues: VuesPourAgent;
      /** Fenêtre principale au premier plan, sinon la dernière qui l'a été. */
      fenetreActive: () => IdFenetre | undefined;
      demander: (o: OngletInfo) => Promise<boolean>;
      /** Carte de consentement des outils de développement ; absente, tout est refusé. */
      demanderOutilsDev?: (o: OngletInfo, d: { droits: DroitDev[]; raison: string; agent: string }, signal?: AbortSignal) => Promise<DroitDev[]>;
      /** Carte « donnees-widget » ; absente, tout est refusé. */
      demanderDonneesWidget?: (o: { id: string; nom: string; agent: string; genre?: "action" | "site" }, signal?: AbortSignal) => Promise<boolean>;
      applications: FenetresPourAgent;
      /** Fenêtres des applis de site : l'agent les voit comme des onglets `site:<id>` ; absentes, il n'en voit aucune. */
      sites?: FenetresSitesPourAgent;
      /** Historique de navigation ; absent, l'agent n'a pas d'outils d'historique. */
      historique?: Pick<Historique, "rechercherPourAgent" | "texteRetenu">;
      /** Session d'un profil de connexion ; absente, pas de lecture invisible pour les widgets. */
      sessionProfil?: (id: string) => Session;
    },
  ) {
    const h = o.historique;
    if (h) {
      this.historique = {
        // Le noyau a vérifié les dates ISO et borné la limite.
        chercher: async ({ requete, depuis, jusqua, limite }) =>
          h.rechercherPourAgent({
            requete,
            limite,
            ...(depuis !== undefined ? { depuis: new Date(depuis) } : {}),
            ...(jusqua !== undefined ? { jusqua: new Date(jusqua) } : {}),
          }),
        lire: async (url) => h.texteRetenu(url),
      };
    }
  }

  /** La fenêtre d'une appli si `id` est `app:<dossier>` ; undefined pour un onglet ordinaire. */
  private fenetreAppli(id: string): WebContents | undefined {
    if (!id.startsWith(PREFIXE_APP)) return undefined;
    const wc = this.o.applications.webContents(id.slice(PREFIXE_APP.length));
    if (!wc) throw new OngletIntrouvable(id);
    return wc;
  }

  /** La vue du site si `id` est `site:<id>` ; undefined pour un autre onglet. Lève OngletIntrouvable si elle est fermée. */
  private vueSite(id: string): WebContents | undefined {
    if (!id.startsWith(PREFIXE_SITE)) return undefined;
    const wc = this.o.sites?.webContents(id.slice(PREFIXE_SITE.length));
    if (!wc || wc.isDestroyed()) throw new OngletIntrouvable(id);
    return wc;
  }

  /** Lit ou capture la vue du site ; fermée pendant l'appel, c'est OngletIntrouvable (une réponse propre, pas un plantage). */
  private async surVueSite<T>(id: string, wc: WebContents, f: (wc: WebContents) => Promise<T>): Promise<T> {
    try {
      return await f(wc);
    } catch (e) {
      if (wc.isDestroyed() || !this.o.sites?.webContents(id.slice(PREFIXE_SITE.length))) throw new OngletIntrouvable(id);
      throw e;
    }
  }

  /** Lève OngletPrive pour un onglet d'espace privé : un appel qui croise le passage en privé ne lit rien. */
  private onglet(id: string): Onglet {
    const etat = this.o.magasin.etat;
    const o = etat.onglets[id];
    if (!o) throw new OngletIntrouvable(id);
    if (ongletPrive(etat, o)) throw new OngletPrive(id);
    return o;
  }

  /** Lit ou capture l'onglet, puis vérifie qu'il n'est pas devenu privé entre-temps. */
  private async horsPrive<T>(id: string, f: (o: Onglet) => Promise<T>): Promise<T> {
    const r = await f(this.onglet(id));
    this.onglet(id);
    return r;
  }

  estPrive(id: string): boolean {
    const etat = this.o.magasin.etat;
    const o = etat.onglets[id];
    return !!o && !interne(o) && ongletPrive(etat, o);
  }

  ongletActifPrive(): boolean {
    const etat = this.o.magasin.etat;
    const o = ongletAffiche(etat, this.o.fenetreActive());
    return !!o && !interne(o) && ongletPrive(etat, o);
  }

  async ongletActif(): Promise<OngletInfo | null> {
    return ongletActifDe(this.o.magasin.etat, this.o.fenetreActive());
  }

  async listerOnglets(): Promise<OngletInfo[]> {
    const apps = this.o.applications.ouvertes().map(ongletApplication);
    const sites = (this.o.sites?.ouvertes() ?? []).map(ongletSite);
    return [...infosOnglets(this.o.magasin.etat), ...apps, ...sites];
  }

  async lireTexte(id: string): Promise<{ texte: string; selection?: string }> {
    const vue = this.vueSite(id);
    if (vue) return this.surVueSite(id, vue, (wc) => this.o.vues.lireTexteDe(wc));
    const wc = this.fenetreAppli(id);
    return wc ? this.o.vues.lireTexteDe(wc) : this.horsPrive(id, (o) => this.o.vues.lireTexte(o));
  }

  /** Les démos de l'agent s'ouvrent au premier plan, marquées ✦ (spec §6). */
  async ouvrirOnglet(url: string, espace?: string): Promise<OngletInfo> {
    const etat = this.o.magasin.etat;
    const f = etat.fenetres.find((x) => x.id === this.o.fenetreActive()) ?? etat.fenetres[0];
    if (!f) throw new Error("Aucune fenêtre ouverte");
    const espaceId = resoudreEspace(etat, f, espace);
    if (etat.espaces.find((e) => e.id === espaceId)?.prive ?? true) throw new Error("Impossible d'ouvrir un onglet ici : l'espace actif est privé.");
    const avant = new Set(Object.keys(etat.onglets));
    this.o.magasin.agir({ type: "ouvrirOnglet", fenetreId: f.id, url, espaceId, activer: true, ouvertParAgent: true });
    const nouveau = Object.values(this.o.magasin.etat.onglets).find((o) => !avant.has(o.id));
    if (!nouveau) throw new Error(`Impossible d'ouvrir ${url}`);
    this.o.magasin.agir({ type: "activerOnglet", id: nouveau.id }); // passe aussi dans son espace
    return info(this.o.magasin.etat, nouveau);
  }

  async naviguer(id: string, url: string): Promise<void> {
    if (this.vueSite(id)) {
      // Jamais un onglet à la place : hors des domaines de l'appli, rien ne se charge (le noyau l'a déjà vérifié).
      if (!this.o.sites!.naviguer(id.slice(PREFIXE_SITE.length), url)) throw new Error(navigationHorsSite(url));
      return;
    }
    const wc = this.fenetreAppli(id);
    if (wc) {
      // La fenêtre d'une appli n'a pas de barre d'adresse : elle ne quitte jamais son origine (loadURL passe outre
      // will-navigate). Ailleurs, c'est un onglet de la fenêtre principale.
      const appli = this.o.applications.ouvertes().find((a) => PREFIXE_APP + a.dossier === id);
      if (appli && memeOrigine(url, appli.url)) void wc.loadURL(url).catch(() => {});
      else await this.ouvrirOnglet(url);
      return;
    }
    this.onglet(id);
    this.o.vues.naviguer(id, url);
  }

  async capturer(id: string): Promise<Buffer> {
    const vue = this.vueSite(id);
    if (vue) return this.surVueSite(id, vue, (wc) => this.o.vues.capturerDe(wc));
    const wc = this.fenetreAppli(id);
    return wc ? this.o.vues.capturerDe(wc) : this.horsPrive(id, (o) => this.o.vues.capturer(o));
  }

  demanderAutorisation(o: OngletInfo): Promise<boolean> {
    return this.o.demander(o);
  }

  /**
   * Lecture invisible pour un widget (voir lecture-invisible.ts) : l'état est relu à chaque appel, un profil passé
   * à un espace privé est refusé (ProfilRefuse). Rien n'entre dans l'état ni dans l'historique.
   */
  async lirePageInvisible(url: string, o: OptionsLecturePage): Promise<PageLue> {
    const sessionProfil = this.o.sessionProfil;
    if (!sessionProfil) throw new Error("Lecture invisible indisponible");
    return lirePageInvisible(url, o, { etat: () => this.o.magasin.etat, sessionProfil });
  }

  /** Le HTML d'une page publique (session vidée avant la lecture, jamais un profil) : voir `lireHtmlInvisible`. */
  async lireHtmlInvisible(url: string, o: { adressesLocales?: boolean; signal?: AbortSignal }): Promise<{ url: string; html: string }> {
    const sessionProfil = this.o.sessionProfil;
    if (!sessionProfil) throw new Error("Lecture invisible indisponible");
    return lireHtmlInvisible(url, o, { etat: () => this.o.magasin.etat, sessionProfil });
  }

  async demanderOutilsDev(o: OngletInfo, d: { droits: DroitDev[]; raison: string; agent: string }, signal?: AbortSignal): Promise<DroitDev[]> {
    return (await this.o.demanderOutilsDev?.(o, d, signal)) ?? [];
  }

  /** L'agent veut voir les données d'un widget lu avec le compte de l'utilisateur ; le noyau retient l'accord pour la conversation. */
  async demanderDonneesWidget(o: { id: string; nom: string; agent: string; genre?: "action" | "site" }, signal?: AbortSignal): Promise<boolean> {
    return (await this.o.demanderDonneesWidget?.(o, signal)) ?? false;
  }

  /** L'adresse est-elle sur les domaines de l'appli de site ouverte ? Faux si elle ne l'est pas. */
  adresseSitePermise(site: string, url: string): boolean {
    return this.o.sites?.adressePermise(site, url) ?? false;
  }
}
