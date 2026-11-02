import { BrowserWindow, WebContentsView, type WebContents } from "electron";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { adresseRelative, droitsDe, empreinteLectureSite, type DeclarationSite } from "@webaios/noyau";
import { ARG_SITE, CANAUX } from "../../commun/canaux";
import { HAUTEUR_BARRE_SITE, PANNEAU_EXTENSIONS_MAX, sourceRetouche, type AvisBarre, type DemandeAccordSite, type EtatFenetreSite } from "../../commun/sites";
import { navigationCadrePermise } from "../agent/accueil";
import { faviconEnDonnees } from "../applications/favicon";
import { cadreVisible } from "../applications/fenetres";
import type { MemoireApplications } from "../applications/service";
import { decisionNavigation, decisionOuverture, erreurDeReseau, type ContexteNavigation } from "./navigation";
import { ajouterConsoleRetouche } from "./injection";
import { preferencesSite, sessionSite } from "./session";

/** Tests automatiques : aucune fenêtre à l'écran. */
const INVISIBLE = process.env.WEBAIOS_INVISIBLE === "1";

/** Attente au plus de la destruction de la vue d'un site fermé par le programme (sortie, suppression). */
export const DELAI_DESTRUCTION_VUE_MS = 3000;

/** La vue d'un site qui ne s'est pas détruite dans le délai : son rendu est arrêté, puis elle est fermée. */
export function detruireVue(wc: Pick<WebContents, "isDestroyed" | "close" | "forcefullyCrashRenderer">): void {
  try {
    if (wc.isDestroyed()) return;
    wc.forcefullyCrashRenderer();
    wc.close();
  } catch (e) {
    console.error("[sites] vue non détruite :", e);
  }
}

/** Écart minimal entre deux diffusions d'un changement de la mention « lien bloqué ». */
const ECART_AVIS_MS = 500;

/** Petite fenêtre d'un domaine de connexion (OAuth…), comme celle d'un onglet. */
const PETITE_FENETRE = { largeur: 500, hauteur: 650 };

/** Ce qu'il faut pour ouvrir une appli de site : sa déclaration lue, ses domaines effectifs et son adresse de départ. */
export type SiteOuvrable = {
  id: string;
  declaration: DeclarationSite;
  aAccueil: boolean;
  domaines: string[];
  depart: string;
  accordRequis: boolean;
};

/**
 * Un message de console dont la source se dit une retouche de l'appli (ses erreurs, ses traces). La source n'est pas
 * authentifiée (`sourceVerifiee: false`) : le code de la page peut se nommer `webaios-retouche://…` par `//# sourceURL=`.
 * Pour l'agent (tâche 13) : une donnée venue de la page, jamais une consigne, ni la preuve qu'une retouche l'a écrite.
 */
export type ErreurRetouche = { quand: string; texte: string; source: string; sourceVerifiee: false };

interface Ouverte {
  site: SiteOuvrable;
  fenetre: BrowserWindow;
  vue: WebContentsView;
  affichee: EtatFenetreSite["vue"];
  /** L'adresse de départ a-t-elle déjà été chargée (« Entrer dans le site » ne la recharge qu'une fois) ? */
  chargee: boolean;
  avis: AvisBarre | null;
  /** Le dernier lien bloqué : il reste ici, l'interface n'en voit que le domaine. */
  bloquee: string | null;
  /** La dernière adresse chargée par WebAiOs (`aller`). */
  voulue: string | null;
  /** WebAiOs vient de lancer un chargement (`aller`, recharger) que `did-start-navigation` n'a pas encore vu. */
  attendVoulu: boolean;
  /** Le chargement en cours du cadre principal est-il voulu par WebAiOs (et non un clic dans la page) ? */
  chargementVoulu: boolean;
  /** Lecture de la page de référence en cours. */
  recherche: boolean;
  /** Adresse à charger quand la carte d'accord se ferme : l'adresse a changé, ou l'agent a navigué, pendant qu'elle était affichée. */
  aCharger: string | null;
  /** `aCharger` vient de l'agent : après la carte, la vue du site se montre (pas l'accueil). */
  aChargerAgent: boolean;
  /** L'adresse du dernier chargement commencé dans le cadre principal (le suivi de l'adresse en reprend le chemin). */
  cible: string | null;
  pleinEcran: boolean;
  /** Dernière diffusion d'un changement de mention (un cadre hostile peut en provoquer des centaines). */
  avisDiffuse: number;
  minuterieAvis: NodeJS.Timeout | undefined;
  /** Petites fenêtres de connexion ouvertes par la page, et pages d'extension : fermées avec l'appli. */
  petites: Set<BrowserWindow>;
  /** Les petites fenêtres des pages d'extension (plan 16), seules que `fermerPageExtension` ferme. */
  pagesExtension: Set<BrowserWindow>;
  /** Hauteur du panneau du menu « Extensions » ouvert sous la barre (0 : fermé) ; la vue est repoussée d'autant. */
  panneau: number;
  /** Console des retouches (les `ERREURS_RETOUCHES_MAX` dernières), gardée jusqu'à la fermeture de la fenêtre. */
  erreurs: ErreurRetouche[];
}

/** L'id d'extension d'une adresse `chrome-extension://<id>/…`, sinon null. */
function extensionDe(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "chrome-extension:" && u.hostname ? u.hostname : null;
  } catch {
    return null;
  }
}

/** Au moins une extension est-elle chargée dans la session de cette page ? */
function extensionsChargees(wc: WebContents): boolean {
  try {
    return wc.session.extensions.getAllExtensions().length > 0;
  } catch {
    return false;
  }
}

/** L'hôte d'une adresse http(s), sinon null (about:blank, javascript:, adresse illisible). */
function hoteHttp(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
}

const uniques = (l: string[]) => [...new Set(l)];

/** L'empreinte des droits demandés par la déclaration (ceux que l'accord retient). */
export function empreinteDroits(d: DeclarationSite): string {
  return createHash("sha256").update(JSON.stringify(droitsDe(d))).digest("hex");
}

/**
 * Ce que la carte d'accord montre : les droits demandés par la déclaration, les fichiers qu'elle injecte, les domaines
 * ajoutés par le suivi de l'adresse, et l'empreinte des droits (renvoyée par « Autoriser »).
 */
function demandeAccord(s: SiteOuvrable): DemandeAccordSite {
  const d = s.declaration;
  const declares = new Set(d.domaines.map((x) => x.toLowerCase()));
  return {
    nom: d.nom,
    domaines: [...d.domaines],
    connexion: [...d.connexion],
    cadres: uniques(d.retouches.flatMap((r) => (r.cadres === false ? [] : r.cadres))),
    reprise: d.reprise,
    fichiers: uniques(d.retouches.flatMap((r) => [...r.js, ...r.css])),
    correspond: uniques(d.retouches.flatMap((r) => r.correspond)),
    suivis: uniques(s.domaines.map((x) => x.toLowerCase()).filter((x) => !declares.has(x))),
    empreinte: empreinteDroits(d),
  };
}

/**
 * Une fenêtre par appli de site ouverte : sa page est l'interface `site.html` (session par défaut, la barre), et le site
 * est dans une `WebContentsView` de la session `persist:site-<id>` posée sous la barre. Le site ne quitte jamais ses
 * domaines (ni ceux de sa connexion) : un lien, une redirection ou une ouverture ailleurs est bloqué et mentionné dans
 * la barre, et ne s'ouvre dans un onglet que sur un clic de l'utilisateur.
 */
export class FenetresSites {
  private readonly ouvertesParId = new Map<string, Ouverte>();

  constructor(
    private readonly o: {
      /** Cadre de fenêtre et favicon de chaque appli (`<profil>/sites.json`). */
      memoire: Pick<MemoireApplications, "lire" | "noter">;
      adressesLocales: boolean;
      /** Un onglet dans la fenêtre principale (« Ouvrir dans un onglet », seulement sur un clic de l'utilisateur). */
      ouvrirOnglet: (url: string) => void;
      /** La fenêtre est fermée, par l'utilisateur ou par le programme. */
      surFermee?: (id: string) => void;
      /** L'appli a montré son favicon (adresse `data:`), déjà retenu. */
      surFavicon?: (id: string) => void;
      /**
       * Le site ne répond plus, ou un chargement voulu par WebAiOs a été renvoyé hors du site, ou l'utilisateur a cliqué
       * « Chercher la nouvelle adresse » : `url` est la page visée (le suivi de l'adresse n'existe que si la déclaration
       * a `suiviAdresse`, jamais appelé sinon).
       */
      surSuivi?: (id: string, url: string | null) => void;
      /**
       * La vue du site vient d'être créée (`creee`), ou va être fermée (`detruite`) : pour les extensions de l'appli
       * (plan 16), c'est son seul onglet web, dans la fenêtre de l'appli.
       */
      surVue?: (id: string, quoi: "creee" | "detruite", wc: WebContents, fenetre: BrowserWindow) => void;
    },
  ) {}

  private signalerVue(id: string, quoi: "creee" | "detruite", wc: WebContents, fenetre: BrowserWindow): void {
    try {
      this.o.surVue?.(id, quoi, wc, fenetre);
    } catch (e) {
      console.error(`[sites] vue de ${id} (${quoi}) non signalée aux extensions :`, e);
    }
  }

  /**
   * Ouvre la fenêtre de l'appli, ou la remet devant sans la recharger (sa déclaration et ses domaines sont repris, et la
   * vue revue : carte si les droits ont grandi, site si l'accueil a disparu).
   */
  ouvrir(s: SiteOuvrable): void {
    const deja = this.ouvertesParId.get(s.id);
    if (deja && !deja.fenetre.isDestroyed()) {
      this.reprendre(deja, s);
      this.montrer(s.id);
      return;
    }
    const o = this.creer(s);
    if (s.accordRequis) o.affichee = "accord";
    else if (s.aAccueil) o.affichee = "accueil";
    else {
      o.affichee = "site";
      this.aller(s.id, s.depart);
    }
    this.placer(o);
    if (!INVISIBLE) o.fenetre.show();
  }

  /** Remet devant la fenêtre de l'appli, sans la recharger ; faux si elle n'est pas ouverte. */
  montrer(id: string): boolean {
    const o = this.ouvertesParId.get(id);
    if (!o || o.fenetre.isDestroyed()) return false;
    if (!INVISIBLE) {
      if (o.fenetre.isMinimized()) o.fenetre.restore();
      o.fenetre.show();
      o.fenetre.focus();
    }
    return true;
  }

  private creer(s: SiteOuvrable): Ouverte {
    const { id } = s;
    const f = new BrowserWindow({
      width: 1200,
      height: 800,
      ...cadreVisible(this.o.memoire.lire(id).cadre),
      minWidth: 360,
      minHeight: 240,
      show: false,
      // Tests : macOS montrerait la fenêtre pour la passer en plein écran ; la page et la vue y passent quand même.
      fullscreenable: !INVISIBLE,
      title: s.declaration.nom,
      backgroundColor: "#1e1e22",
      // macOS : les boutons de la fenêtre sont dans la barre, centrés sur ses 36 px.
      ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 12, y: 11 } } : {}),
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Le preload tourne aussi dans le cadre de l'accueil (code de l'agent) pour y poser la garde des widgets.
        nodeIntegrationInSubFrames: true,
        additionalArguments: [`${ARG_SITE}${id}`],
      },
    });
    const vue = new WebContentsView({ webPreferences: preferencesSite(sessionSite(id)) });
    vue.setBackgroundColor("#ffffff");
    vue.setVisible(false);
    f.contentView.addChildView(vue);
    const o: Ouverte = { site: s, fenetre: f, vue, affichee: "site", chargee: false, avis: null, bloquee: null, voulue: null, attendVoulu: false, chargementVoulu: false, recherche: false, aCharger: null, aChargerAgent: false, cible: null, pleinEcran: false, petites: new Set(), pagesExtension: new Set(), panneau: 0, avisDiffuse: 0, minuterieAvis: undefined, erreurs: [] };
    this.ouvertesParId.set(id, o);

    // Le titre de la fenêtre est le nom de l'appli, jamais celui de la page.
    f.on("page-title-updated", (e) => e.preventDefault());
    f.on("resize", () => this.placer(o));
    const noterCadre = () => this.noterCadre(id, f);
    f.on("resize", noterCadre);
    f.on("move", noterCadre);
    f.on("close", noterCadre);
    f.on("closed", () => {
      clearTimeout(o.minuterieAvis);
      for (const p of o.petites) if (!p.isDestroyed()) p.destroy();
      if (!vue.webContents.isDestroyed()) {
        this.signalerVue(id, "detruite", vue.webContents, f);
        vue.webContents.close();
      }
      if (this.ouvertesParId.get(id) === o) this.ouvertesParId.delete(id);
      this.o.surFermee?.(id);
    });

    // L'interface ne quitte jamais sa page et n'ouvre rien. Son seul cadre, l'accueil de cette appli, ne va que vers ses
    // propres pages (jamais le web, ni l'accueil d'une autre appli) : ses demandes passent par postMessage.
    const ui = f.webContents;
    ui.on("will-navigate", (e) => e.preventDefault());
    ui.on("will-frame-navigate", (e) => {
      if (!e.isMainFrame && !navigationCadrePermise(e.frame?.url ?? "", e.url, id)) e.preventDefault();
    });
    ui.setWindowOpenHandler(() => ({ action: "deny" }));
    // Comme les widgets : WebRTC (s'il échappait à la garde) ne passe que par le proxy de la session, qui ne mène nulle part.
    ui.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    if (process.env.ELECTRON_RENDERER_URL) void ui.loadURL(`${process.env.ELECTRON_RENDERER_URL}/site.html?id=${encodeURIComponent(id)}`).catch(() => {});
    else void ui.loadFile(join(__dirname, "../renderer/site.html"), { query: { id } }).catch(() => {});

    this.equiperVue(o);
    this.signalerVue(id, "creee", vue.webContents, f);
    return o;
  }

  private contexte(o: Ouverte): ContexteNavigation {
    return { domaines: o.site.domaines, connexion: o.site.declaration.connexion, adressesLocales: this.o.adressesLocales };
  }

  private equiperVue(o: Ouverte): void {
    const { id } = o.site;
    const wc = o.vue.webContents;
    const diffuser = () => this.diffuserEtat(o);
    // Le code du site n'a pas été relu : son « beforeunload » n'empêche jamais de fermer l'appli.
    wc.on("will-prevent-unload", (e) => e.preventDefault());
    wc.on("did-navigate", () => {
      // Une nouvelle page : la mention d'un lien bloqué sur la précédente tombe.
      if (o.avis?.genre === "lien-bloque") {
        o.avis = null;
        o.bloquee = null;
      }
      diffuser();
    });
    wc.on("did-navigate-in-page", (_e, _url, principal) => {
      if (principal) diffuser();
    });
    wc.on("did-stop-loading", diffuser);
    // La console des retouches de l'agent : leurs sources sont nommées `webaios-retouche://<id>/<fichier>` (page et cadres).
    const prefixe = sourceRetouche(id, "");
    wc.on("console-message", (ev) => {
      const source = typeof ev.sourceId === "string" ? ev.sourceId : "";
      if (!source.startsWith(prefixe)) return;
      ajouterConsoleRetouche(o.erreurs, { texte: String(ev.message), source: ev.lineNumber ? `${source}:${ev.lineNumber}` : source }, new Date().toISOString());
    });
    wc.on("page-favicon-updated", (_e, favicons) => {
      const url = favicons[0];
      if (!url) return;
      void faviconEnDonnees((u, init) => wc.session.fetch(u, init), url, wc.getURL()).then((d) => {
        // Fenêtre fermée (ou appli supprimée) pendant la lecture : rien n'est retenu.
        if (this.ouvertesParId.get(id) !== o || o.fenetre.isDestroyed()) return;
        if (!d || this.o.memoire.lire(id).favicon === d) return;
        this.o.memoire.noter(id, { favicon: d });
        this.o.surFavicon?.(id);
      });
    });

    // Page principale seulement : un sous-cadre (lecteur, publicité) va où il veut, il ne change pas la page.
    const garder = (e: Electron.Event, url: string) => {
      if (decisionNavigation(url, this.contexte(o)) === "suivre") return;
      e.preventDefault();
      this.bloquer(o, url);
    };
    wc.on("will-frame-navigate", (e) => {
      if (e.isMainFrame) garder(e, e.url);
    });
    wc.on("will-redirect", (e) => {
      if (!e.isMainFrame) return;
      garder(e, e.url);
      // Renvoyé hors du site (domaine parqué) pendant un chargement voulu par WebAiOs : le site a peut-être déménagé.
      // Un clic de l'utilisateur dans la page, lui, ne cherche rien.
      if (e.defaultPrevented && o.chargementVoulu && this.suiviActif(o)) this.o.surSuivi?.(id, o.cible);
    });
    // Le chargement qui commence est voulu si WebAiOs vient de le lancer ; ses redirections gardent ce caractère.
    wc.on("did-start-navigation", (d) => {
      if (!d.isMainFrame || d.isSameDocument) return;
      o.chargementVoulu = o.attendVoulu;
      o.attendVoulu = false;
      o.cible = d.url;
    });
    wc.on("did-stop-loading", () => {
      o.chargementVoulu = false;
    });
    // C8 : la vue ne montre que le web. Un chargement lancé par le main sans passer par `will-frame-navigate` (`tabs.update`
    // d'une extension vers sa propre page, par exemple) est arrêté s'il n'est pas http(s). M1 : quand une extension est
    // chargée dans la session de l'appli, la vue cachée (accueil, carte d'accord) ne charge que ce que WebAiOs lance
    // (`chargementVoulu`, posé par l'écouteur plus haut) : jamais une page de l'appli demandée par `tabs.update` avant
    // « Entrer dans le site » ou avant le choix de l'utilisateur. Sans extension, rien ne change (plan 15).
    wc.on("did-start-navigation", (d) => {
      if (!d.isMainFrame || d.isSameDocument) return;
      const web = /^https?:/i.test(d.url);
      if (web && (o.affichee === "site" || o.chargementVoulu || !extensionsChargees(wc))) return;
      console.warn(`[sites] ${id} : chargement arrêté dans la vue (${web ? `vue ${o.affichee}, non voulu` : "hors du web"}) : ${d.url.slice(0, 80)}`);
      wc.stop();
    });
    wc.on("did-fail-load", (_e, code, _description, url, principal) => {
      if (principal && erreurDeReseau(code) && this.suiviActif(o)) this.o.surSuivi?.(id, url || o.cible);
    });

    wc.setWindowOpenHandler(({ url }) => {
      const d = decisionOuverture(url, this.contexte(o));
      if (d === "dans-l-appli") {
        // `target=_blank` vers le site : la vue de l'appli y va, aucune fenêtre ne s'ouvre.
        setImmediate(() => {
          if (!wc.isDestroyed()) void wc.loadURL(url).catch(() => {});
        });
        return { action: "deny" };
      }
      if (d === "petite-fenetre") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: PETITE_FENETRE.largeur,
            height: PETITE_FENETRE.hauteur,
            show: !INVISIBLE,
            autoHideMenuBar: true,
            webPreferences: preferencesSite(wc.session),
          },
        };
      }
      this.bloquer(o, url);
      return { action: "deny" };
    });
    wc.on("did-create-window", (petite) => this.equiperPetite(o, petite));

    // Plein écran d'un élément (vidéo) : la vue prend toute la fenêtre, par-dessus la barre ; à la sortie, la barre revient.
    wc.on("enter-html-full-screen", () => {
      o.pleinEcran = true;
      this.placer(o);
    });
    wc.on("leave-html-full-screen", () => {
      o.pleinEcran = false;
      this.placer(o);
    });
  }

  private suiviActif(o: Ouverte): boolean {
    return o.site.declaration.suiviAdresse !== undefined;
  }

  /** Recharge la page du site, comme un chargement voulu par WebAiOs (le suivi de l'adresse en tient compte). */
  private recharge(o: Ouverte): void {
    o.attendVoulu = true;
    o.vue.webContents.reload();
  }

  /** Une petite fenêtre de connexion : même session, bornée au site et à sa connexion, sans rien ouvrir d'autre. */
  private equiperPetite(o: Ouverte, petite: BrowserWindow): void {
    o.petites.add(petite);
    petite.on("closed", () => o.petites.delete(petite));
    const wc = petite.webContents;
    wc.on("will-prevent-unload", (e) => e.preventDefault());
    const garder = (e: Electron.Event, url: string) => {
      if (decisionNavigation(url, this.contexte(o)) !== "suivre") e.preventDefault();
    };
    wc.on("will-frame-navigate", (e) => {
      if (e.isMainFrame) garder(e, e.url);
    });
    wc.on("will-redirect", (e) => {
      if (e.isMainFrame) garder(e, e.url);
    });
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
  }

  /** Bloqué : l'URL reste ici (pour « Ouvrir dans un onglet »), la barre ne montre que son domaine. */
  private bloquer(o: Ouverte, url: string): void {
    const domaine = hoteHttp(url);
    // about:blank, javascript: : refusé sans rien proposer (il n'y a rien à ouvrir dans un onglet).
    if (!domaine) return;
    o.bloquee = url;
    if (o.avis?.genre === "lien-bloque" && o.avis.domaine === domaine) return;
    o.avis = { genre: "lien-bloque", domaine };
    this.diffuserAvis(o);
  }

  /** Au plus un changement de mention diffusé par `ECART_AVIS_MS` ; le dernier part toujours (en différé). */
  private diffuserAvis(o: Ouverte): void {
    if (o.minuterieAvis) return;
    const attente = o.avisDiffuse + ECART_AVIS_MS - Date.now();
    const diffuser = () => {
      o.minuterieAvis = undefined;
      o.avisDiffuse = Date.now();
      this.diffuserEtat(o);
    };
    if (attente <= 0) diffuser();
    else o.minuterieAvis = setTimeout(diffuser, attente);
  }

  /**
   * L'entrée d'historique visée par « précédent » ou « suivant » est revue avec les règles d'aujourd'hui : les domaines
   * ont pu rétrécir depuis la visite (site.json réécrit, appli rouverte). Vrai si elle est permise.
   */
  private historiquePermis(o: Ouverte, ecart: -1 | 1): boolean {
    const h = o.vue.webContents.navigationHistory;
    const i = h.getActiveIndex() + ecart;
    if (i < 0 || i >= h.length()) return false;
    const url = h.getEntryAtIndex(i)?.url ?? "";
    if (decisionNavigation(url, this.contexte(o)) === "suivre") return true;
    this.bloquer(o, url);
    return false;
  }

  /** La vue du site sous la barre (toute la fenêtre en plein écran), visible seulement en vue « site ». */
  private placer(o: Ouverte): void {
    if (o.fenetre.isDestroyed()) return;
    const [largeur = 0, hauteur = 0] = o.fenetre.getContentSize();
    const haut = o.pleinEcran ? 0 : HAUTEUR_BARRE_SITE + o.panneau;
    o.vue.setBounds({ x: 0, y: haut, width: largeur, height: Math.max(0, hauteur - haut) });
    o.vue.setVisible(o.affichee === "site");
  }

  private diffuserEtat(o: Ouverte): void {
    const e = this.etatDe(o);
    if (!o.fenetre.isDestroyed() && !o.fenetre.webContents.isDestroyed()) o.fenetre.webContents.send(CANAUX.siteEtatChange, e);
  }

  private etatDe(o: Ouverte): EtatFenetreSite {
    const wc = o.vue.webContents;
    const vivante = !wc.isDestroyed();
    const url = vivante ? wc.getURL() : "";
    return {
      id: o.site.id,
      nom: o.site.declaration.nom,
      vue: o.affichee,
      aAccueil: o.site.aAccueil,
      domaine: hoteHttp(url) ?? hoteHttp(o.site.depart) ?? "",
      peutReculer: vivante && wc.navigationHistory.canGoBack(),
      peutAvancer: vivante && wc.navigationHistory.canGoForward(),
      suivi: o.site.declaration.suiviAdresse !== undefined,
      recherche: o.recherche,
      avis: o.avis,
      accord: o.affichee === "accord" ? demandeAccord(o.site) : null,
    };
  }

  etat(id: string): EtatFenetreSite | null {
    const o = this.ouverte(id);
    return o ? this.etatDe(o) : null;
  }

  private ouverte(id: string): Ouverte | undefined {
    const o = this.ouvertesParId.get(id);
    return o && !o.fenetre.isDestroyed() ? o : undefined;
  }

  /** L'appli dont `sender` est l'interface (`site.html`) ; undefined pour tout autre expéditeur. */
  idDeInterface(sender: WebContents): string | undefined {
    for (const [id, o] of this.ouvertesParId) if (!o.fenetre.isDestroyed() && o.fenetre.webContents === sender) return id;
    return undefined;
  }

  /** La vue du site (celle que l'agent lit, capture et pilote). */
  vueSite(id: string): WebContents | undefined {
    const wc = this.ouverte(id)?.vue.webContents;
    return wc && !wc.isDestroyed() ? wc : undefined;
  }

  /** L'adresse est-elle sur les domaines de l'appli ouverte (jamais ceux de sa connexion) ? */
  adressePermise(id: string, url: string): boolean {
    const o = this.ouverte(id);
    return !!o && decisionOuverture(url, this.contexte(o)) === "dans-l-appli";
  }

  /** Les fenêtres ouvertes : `url` est la page affichée, `domaine` le domaine actuel de l'appli (celui de son départ). */
  /** `empreinte` : celle de la déclaration d'aujourd'hui (relue à chaque changement de site.json), pour l'accord de l'agent. */
  ouvertes(): { id: string; nom: string; url: string; domaine: string; empreinte: string }[] {
    return [...this.ouvertesParId.values()]
      .filter((o) => !o.fenetre.isDestroyed())
      .map((o) => ({
        id: o.site.id,
        nom: o.site.declaration.nom,
        url: (!o.vue.webContents.isDestroyed() && o.vue.webContents.getURL()) || o.site.depart,
        domaine: hoteHttp(o.site.depart) ?? "",
        empreinte: empreinteLectureSite(o.site.declaration),
      }));
  }

  /** La console des retouches de l'appli ouverte (vide si elle ne l'est pas). */
  erreursRetouches(id: string): ErreurRetouche[] {
    return (this.ouverte(id)?.erreurs ?? []).map((e) => ({ ...e }));
  }

  /**
   * La déclaration de l'appli ouverte a changé (site.json, retouches) : reprise sans montrer la fenêtre. Vrai si la page
   * du site a été rechargée (la carte revient sur une page chargée).
   */
  mettreAJour(s: SiteOuvrable): boolean {
    const o = this.ouverte(s.id);
    return o ? this.reprendre(o, s) : false;
  }

  /**
   * La fenêtre ouverte prend la nouvelle lecture de l'appli, et sa vue est revue. Les droits demandés ont grandi (accord
   * qui ne couvre plus, ou nouveaux droits après « Ouvrir sans retouches ») : la carte revient, la vue du site est cachée
   * (rien n'y est injecté avant le choix, puisque l'accord manque). L'accord n'est plus nécessaire : la vue suivante.
   * L'accueil a disparu : le site. Vrai si la page du site a été rechargée : quand la carte revient sur une page déjà
   * chargée, ses retouches d'avant n'y restent pas.
   */
  private reprendre(o: Ouverte, s: SiteOuvrable): boolean {
    const avant = o.site;
    o.site = s;
    let rechargee = false;
    const droitsGrandis = JSON.stringify(droitsDe(avant.declaration)) !== JSON.stringify(droitsDe(s.declaration));
    if (s.accordRequis && o.affichee !== "accord" && (!avant.accordRequis || droitsGrandis)) {
      o.affichee = "accord";
      if (o.chargee && !o.vue.webContents.isDestroyed()) {
        this.recharge(o);
        rechargee = true;
      }
    } else if (o.affichee === "accord" && !s.accordRequis) this.vueSuivante(o);
    else if (o.affichee === "accueil" && !s.aAccueil) this.vueSuivante(o);
    this.placer(o);
    this.diffuserEtat(o);
    return rechargee;
  }

  /** Après la carte : l'accueil s'il y en a un, sinon le site (chargé sur son départ la première fois). */
  private vueSuivante(o: Ouverte): void {
    const agent = o.aChargerAgent;
    o.aChargerAgent = false;
    if (o.aCharger) {
      const vers = o.aCharger;
      o.aCharger = null;
      this.aller(o.site.id, vers);
    }
    // L'agent a demandé une adresse pendant la carte : c'est elle que l'utilisateur voit, même si l'appli a un accueil.
    if (o.site.aAccueil && !agent) o.affichee = "accueil";
    else {
      o.affichee = "site";
      if (!o.chargee) this.aller(o.site.id, o.site.depart);
    }
  }

  /**
   * Le choix de l'utilisateur sur la carte (l'accord, s'il l'a donné, est déjà retenu dans `s`) : la vue suivante. Avec les
   * retouches, une page déjà chargée (sans elles) est rechargée pour les recevoir. Rien si la carte n'est pas affichée.
   */
  apresAccord(id: string, s: SiteOuvrable | null): void {
    const o = this.ouverte(id);
    if (!o || o.affichee !== "accord") return;
    if (s) o.site = s;
    // L'accord donné ne couvre pas la déclaration d'aujourd'hui (site.json réécrit pendant le choix) : la carte reste.
    if (s?.accordRequis) return this.diffuserEtat(o);
    const recharger = s !== null && o.chargee && o.aCharger === null;
    this.vueSuivante(o);
    if (recharger && !o.vue.webContents.isDestroyed()) this.recharge(o);
    this.placer(o);
    this.diffuserEtat(o);
  }

  /** Recharge la page du site si elle a été chargée (retouches réécrites), quelle que soit la vue affichée. */
  rechargerVue(id: string): void {
    const o = this.ouverte(id);
    if (o?.chargee && !o.vue.webContents.isDestroyed()) this.recharge(o);
  }

  /** Rediffuse l'état de la fenêtre (la carte à jour, après un « Autoriser » sur des droits qui ont changé). */
  rediffuser(id: string): void {
    const o = this.ouverte(id);
    if (o) this.diffuserEtat(o);
  }

  /** L'appli telle qu'elle a été ouverte (déclaration, domaines effectifs, départ), si sa fenêtre l'est. */
  site(id: string): SiteOuvrable | undefined {
    return this.ouverte(id)?.site;
  }

  /** Envoie un message à l'interface de la fenêtre de l'appli (son accueil), si elle est ouverte. */
  envoyer(id: string, canal: string, valeur: unknown): void {
    const o = this.ouverte(id);
    if (o && !o.fenetre.webContents.isDestroyed()) o.fenetre.webContents.send(canal, valeur);
  }

  /** L'accueil a demandé `url` (déjà vérifiée) : la vue du site y va et se montre ; faux si l'accueil n'est pas affiché. */
  depuisAccueil(id: string, url: string): boolean {
    const o = this.ouverte(id);
    if (o?.affichee !== "accueil") return false;
    this.aller(id, url);
    this.entrer(id);
    return true;
  }

  /** « Entrer dans le site » : l'adresse de départ la première fois, la page où il était ensuite. */
  entrer(id: string): void {
    const o = this.ouverte(id);
    if (!o || o.affichee === "accord") return;
    o.affichee = "site";
    if (!o.chargee) this.aller(id, o.site.depart);
    this.placer(o);
    this.diffuserEtat(o);
  }

  /** ⌂ : l'écran d'accueil ; la page du site reste chargée, cachée dessous. */
  accueil(id: string): void {
    const o = this.ouverte(id);
    if (!o || !o.site.aAccueil || o.affichee === "accord") return;
    o.affichee = "accueil";
    this.placer(o);
    this.diffuserEtat(o);
  }

  precedent(id: string): void {
    const o = this.ouverte(id);
    if (o?.affichee === "site" && o.vue.webContents.navigationHistory.canGoBack() && this.historiquePermis(o, -1)) o.vue.webContents.navigationHistory.goBack();
  }

  suivant(id: string): void {
    const o = this.ouverte(id);
    if (o?.affichee === "site" && o.vue.webContents.navigationHistory.canGoForward() && this.historiquePermis(o, 1)) o.vue.webContents.navigationHistory.goForward();
  }

  recharger(id: string): void {
    const o = this.ouverte(id);
    if (o?.affichee === "site" && o.chargee) this.recharge(o);
  }

  /** « Ouvrir dans un onglet » : le dernier lien bloqué, dans la fenêtre principale ; la mention tombe. */
  ouvrirBloque(id: string): void {
    const o = this.ouverte(id);
    if (!o?.bloquee) return;
    const url = o.bloquee;
    o.bloquee = null;
    if (o.avis?.genre === "lien-bloque") o.avis = null;
    this.diffuserEtat(o);
    this.o.ouvrirOnglet(url);
  }

  /** Chargement voulu par WebAiOs (départ, adresse de l'accueil, suivi) : noté pour le suivi de l'adresse. */
  aller(id: string, url: string): void {
    const o = this.ouverte(id);
    if (!o) return;
    o.chargee = true;
    o.voulue = url;
    o.attendVoulu = true;
    void o.vue.webContents.loadURL(url).catch(() => {
      // Site injoignable, ou chargement remplacé aussitôt : did-fail-load le dit (suivi de l'adresse).
      o.attendVoulu = false;
    });
  }

  /**
   * L'agent fait naviguer l'appli (après l'accord de l'utilisateur pour cette conversation) : seulement sur les domaines de
   * l'appli, comme un chargement voulu par WebAiOs (règles de navigation et suivi de l'adresse s'appliquent). Depuis
   * l'accueil, la vue du site se montre. La carte d'accord des retouches affichée : « en-attente », l'adresse se charge
   * après le choix de l'utilisateur, et la vue du site se montre alors (pas l'accueil). « refuse » : l'appli n'est pas ouverte
   * ou l'adresse est hors de ses domaines (rien n'est chargé).
   */
  naviguerPourAgent(id: string, url: string): "charge" | "en-attente" | "refuse" {
    const o = this.ouverte(id);
    if (!o || o.vue.webContents.isDestroyed() || !this.adressePermise(id, url)) return "refuse";
    if (o.affichee === "accord") {
      o.aCharger = url;
      o.aChargerAgent = true;
      return "en-attente";
    }
    this.aller(id, url);
    if (o.affichee === "accueil") {
      o.affichee = "site";
      this.placer(o);
    }
    this.diffuserEtat(o);
    return "charge";
  }

  /** « Chercher la nouvelle adresse » (bouton de la barre, appli avec suiviAdresse seulement). */
  chercherAdresse(id: string): void {
    const o = this.ouverte(id);
    if (!o || !this.suiviActif(o)) return;
    const wc = o.vue.webContents;
    // La page affichée si elle est sur le site, sinon (page d'erreur, lien bloqué…) l'adresse de départ.
    const url = wc.isDestroyed() ? "" : wc.getURL();
    this.o.surSuivi?.(id, url && adresseRelative(url, o.site.domaines) !== null ? url : null);
  }

  /** Une lecture de la page de référence commence ou finit : le bouton le montre. */
  cherche(id: string, oui: boolean): void {
    const o = this.ouverte(id);
    if (!o) return;
    o.recherche = oui;
    this.diffuserEtat(o);
  }

  /**
   * Le suivi a trouvé la nouvelle adresse : l'appli ouverte prend ses domaines effectifs et son départ à jour (retouches,
   * pont de la mémoire et reprise les relisent à chaque cadre), et la vue va à la même adresse sur le nouveau domaine.
   * `vers` : l'adresse à charger, déjà calculée par le service.
   */
  adresseChangee(id: string, domaines: string[], depart: string, vers: string): void {
    const o = this.ouverte(id);
    if (!o) return;
    o.site = { ...o.site, domaines, depart };
    if (o.affichee === "accord") {
      // La carte est affichée : la vue ne charge rien avant le choix ; la page déjà chargée l'était sur l'ancien domaine.
      if (o.chargee) {
        o.aCharger = vers;
        o.aChargerAgent = false;
      }
      return this.diffuserEtat(o);
    }
    this.aller(id, vers);
    this.diffuserEtat(o);
  }

  /** La mention de la barre (lien bloqué, adresse changée…) ; null l'efface. */
  avis(id: string, a: AvisBarre | null): void {
    const o = this.ouverte(id);
    if (!o) return;
    o.avis = a;
    if (a?.genre !== "lien-bloque") o.bloquee = null;
    this.diffuserEtat(o);
  }

  /** Taille et position retenues aussitôt (la mémoire écrit en différé). */
  private noterCadre(id: string, f: BrowserWindow): void {
    if (f.isDestroyed() || f.isFullScreen() || f.isMinimized()) return;
    const { x, y, width, height } = f.getNormalBounds();
    this.o.memoire.noter(id, { cadre: { x, y, largeur: width, hauteur: height } });
  }

  /**
   * Fermeture voulue par le programme (suppression, sortie) : cadre noté, fenêtre détruite sans demander à la page.
   * Rendue quand la vue du site est détruite (sa session peut alors être effacée) : null. Au plus `delaiMs` d'attente :
   * passé ce délai, la vue encore vivante est rendue (à détruire par `detruireVue`), pour que la sortie ou la
   * suppression continue.
   */
  fermer(id: string, delaiMs = DELAI_DESTRUCTION_VUE_MS): Promise<WebContents | null> {
    const o = this.ouvertesParId.get(id);
    if (!o || o.fenetre.isDestroyed()) return Promise.resolve(null);
    const wc = o.vue.webContents;
    const detruite = wc.isDestroyed()
      ? Promise.resolve(null)
      : new Promise<WebContents | null>((ok) => {
          const minuterie = setTimeout(() => ok(wc.isDestroyed() ? null : wc), delaiMs);
          wc.once("destroyed", () => {
            clearTimeout(minuterie);
            ok(null);
          });
        });
    this.noterCadre(id, o.fenetre);
    o.fenetre.destroy();
    return detruite;
  }

  // ——— Les extensions de l'appli (plan 16) ———

  /** La vue du site de l'appli ouverte et sa fenêtre (son seul onglet pour les extensions), ou null. */
  vueEtFenetre(id: string): { wc: WebContents; fenetre: BrowserWindow } | null {
    const o = this.ouverte(id);
    if (!o || o.vue.webContents.isDestroyed()) return null;
    return { wc: o.vue.webContents, fenetre: o.fenetre };
  }

  /**
   * Une extension de l'appli veut ouvrir `url` (`verifierUrl` de la bibliothèque) : sa propre page, ou une page de
   * l'appli. Une autre adresse web est bloquée et mentionnée dans la barre (C7 : l'entrée « page d'accueil » du menu du
   * bouton aussi) ; tout le reste (page d'une autre extension, javascript:, file:…) est refusé sans rien dire.
   */
  urlPermisePourExtension(id: string, extensionId: string, url: string): boolean {
    const o = this.ouverte(id);
    if (!o) return false;
    if (extensionDe(url) !== null) return extensionDe(url) === extensionId;
    if (decisionOuverture(url, this.contexte(o)) === "dans-l-appli") return true;
    this.bloquer(o, url);
    return false;
  }

  /**
   * Ce qu'une extension de l'appli ouvre (`tabs.create`, `windows.create`, `runtime.openOptionsPage`) : une page d'une
   * extension chargée dans l'appli s'ouvre dans une petite fenêtre cachée en test, de la session de l'appli, fermée avec
   * elle ; une page de l'appli fait aller la vue (comme une navigation demandée par l'agent). L'adresse est revérifiée
   * ici : `openOptionsPage` ne passe pas par `verifierUrl`. Tout le reste lève.
   */
  async ouvrirPourExtension(id: string, url: string): Promise<[WebContents, BrowserWindow]> {
    const o = this.ouverte(id);
    if (!o) throw new Error(`appli de site fermée : ${id}`);
    const extension = extensionDe(url);
    if (extension !== null) {
      // M5 : seule l'extension chargée est vérifiée ici, pas celle qui appelle (inconnue). Que ce soit sa propre page est
      // garanti en amont : `verifierUrl` (tabs.create, tabs.update, windows.create, entrées du menu du bouton) exige le
      // même id, et `runtime.openOptionsPage` construit l'adresse depuis `extension.id`. Un futur appel de `site.ouvrir`
      // ne doit pas supposer davantage.
      if (!sessionSite(id).extensions.getExtension(extension)) throw new Error(`page d'une extension absente de l'appli ${id}`);
      return this.ouvrirPageExtension(o, extension, url);
    }
    if (o.vue.webContents.isDestroyed() || this.naviguerPourAgent(id, url) === "refuse") throw new Error(`adresse refusée dans l'appli ${id}`);
    return [o.vue.webContents, o.fenetre];
  }

  private ouvrirPageExtension(o: Ouverte, extension: string, url: string): [WebContents, BrowserWindow] {
    const petite = new BrowserWindow({
      width: PETITE_FENETRE.largeur,
      height: PETITE_FENETRE.hauteur,
      show: !INVISIBLE,
      fullscreenable: !INVISIBLE,
      autoHideMenuBar: true,
      webPreferences: { session: sessionSite(o.site.id), sandbox: true, contextIsolation: true },
    });
    o.petites.add(petite);
    o.pagesExtension.add(petite);
    petite.on("closed", () => {
      o.petites.delete(petite);
      o.pagesExtension.delete(petite);
    });
    const wc = petite.webContents;
    wc.on("will-prevent-unload", (e) => e.preventDefault());
    // Sa page principale ne quitte jamais l'origine de son extension.
    const garder = (e: Electron.Event, vers: string) => {
      if (extensionDe(vers) !== extension) e.preventDefault();
    };
    wc.on("will-frame-navigate", (e) => {
      if (e.isMainFrame) garder(e, e.url);
    });
    wc.on("will-redirect", (e) => {
      if (e.isMainFrame) garder(e, e.url);
    });
    // M7 : `tabs.update` de cette fenêtre (un onglet pour la bibliothèque) charge par le main, sans `will-frame-navigate`.
    wc.on("did-start-navigation", (d) => {
      if (d.isMainFrame && !d.isSameDocument && extensionDe(d.url) !== extension) wc.stop();
    });
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    void wc.loadURL(url).catch(() => {});
    return [wc, petite];
  }

  /** `tabs.remove` d'une page d'extension : sa petite fenêtre, si c'en est une ouverte ici ; rien sinon. */
  fermerPageExtension(wc: WebContents): void {
    for (const o of this.ouvertesParId.values())
      for (const p of o.pagesExtension) {
        if (p.isDestroyed() || p.webContents !== wc) continue;
        p.close();
        return;
      }
  }

  /** Le panneau du menu « Extensions » s'ouvre (sa hauteur) ou se ferme (0) : la vue du site est repoussée d'autant. */
  panneauExtensions(id: string, hauteur: number): void {
    const o = this.ouverte(id);
    if (!o) return;
    o.panneau = Number.isFinite(hauteur) ? Math.round(Math.min(PANNEAU_EXTENSIONS_MAX, Math.max(0, hauteur))) : 0;
    this.placer(o);
  }

  /** Envoie un message à l'interface de chaque appli ouverte (`CANAUX.extensionsChange`). */
  diffuserATous(canal: string, valeur: unknown): void {
    for (const o of this.ouvertesParId.values()) if (!o.fenetre.isDestroyed() && !o.fenetre.webContents.isDestroyed()) o.fenetre.webContents.send(canal, valeur);
  }

  /** ⌘R, ⌥⌘I ou ⌘W sur la fenêtre d'appli de site au premier plan ; vrai si c'en est une. */
  surPremierPlan(action: "recharger" | "outils" | "fermer"): boolean {
    const focus = BrowserWindow.getFocusedWindow();
    const o = [...this.ouvertesParId.values()].find((x) => x.fenetre === focus && !x.fenetre.isDestroyed());
    if (!o) return false;
    if (action === "recharger") this.recharger(o.site.id);
    else if (action === "outils") o.vue.webContents.toggleDevTools();
    else o.fenetre.close();
    return true;
  }
}
