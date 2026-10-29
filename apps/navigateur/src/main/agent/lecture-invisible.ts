import { BrowserWindow, session, type Session, type WebContents } from "electron";
import { adresseLocale, ProfilRefuse, siteMenage, type ChangerHote, type OptionsLecturePage, type PageLue } from "@webaios/noyau";
import type { EtatNavigateur, IdProfil } from "../../commun/modele";
import { marquerInvisible } from "../contenus-invisibles";

/** Session des lectures publiques : sans `persist:`, rien n'est écrit sur le disque ; vidée avant chaque lecture. */
export const PARTITION_PUBLIQUE = "webaios-lecture-publique";
const DELAI_TOTAL_MS = 30_000;
const TROP_LENTE = "Page trop lente : 30 s dépassées";
/** Sauts vers un autre site suivis au plus par une lecture ménagée (comme MAX_REDIRECTIONS de `recuperer`). */
const MAX_SAUTS = 5;
/** Une page chargée encore en mouvement 4 s avant la fin des 30 s est lue telle quelle, pour finir à temps. */
const MARGE_LECTURE_FORCEE_MS = 4_000;
const CALME_MS = 2_000;
const MAX_TEXTE = 20_000;
const MAX_LIENS = 400;
/** Avec `defiler` : une page défilée montre plus d'éléments, d'où des plafonds plus hauts. */
const MAX_TEXTE_DEFILEE = 100_000;
const MAX_LIENS_DEFILEE = 1_000;
/** Après un défilement : 1 s sans croissance de la page ni chargement en cours, hauteur relevée toutes les 250 ms. */
const CALME_DEFILEMENT_MS = 1_000;
const RELEVE_MS = 250;
const DEFILER_MAX = 20;
/** Au plus 2 Mo de HTML rendus par `lireHtmlInvisible`. */
export const HTML_MAX = 2 * 1024 * 1024;
const LECTURES_SIMULTANEES = 2;
/** Code Chromium d'une navigation remplacée par une autre (redirection par script, meta refresh) : pas un échec. */
const ERR_ABORTED = -3;

/** Les profils de connexion qu'une lecture peut utiliser : ceux de l'état qu'aucun espace privé n'utilise. */
export function profilsLisibles(etat: Pick<EtatNavigateur, "profils" | "espaces">): IdProfil[] {
  const prives = new Set(etat.espaces.filter((e) => e.prive).map((e) => e.profil));
  return etat.profils.map((p) => p.id).filter((id) => !prives.has(id));
}

/** Un nom d'hôte comparable : en minuscules, sans point final (`exemple.test.` est `exemple.test`). */
const normaliser = (hote: string) => hote.toLowerCase().replace(/\.+$/, "");

/**
 * L'URL peut être chargée : http(s) seulement, jamais une adresse de la machine ou du réseau local (sauf
 * `adressesLocales`, tests seulement) ; avec `domaines`, son hôte doit être l'un d'eux exactement, comme le vérifie le
 * noyau (packages/noyau/src/widgets/recolte.ts, `verifierUrl`) : un sous-domaine n'y est pas permis.
 */
export function urlPermise(brute: string, domaines: readonly string[] | undefined, adressesLocales = false): boolean {
  let u: URL;
  try {
    u = new URL(brute);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!adressesLocales && adresseLocale(u.hostname)) return false;
  return !domaines || domaines.map(normaliser).includes(normaliser(u.hostname));
}

/** Le site d'une adresse pour le ménagement (`siteMenage` du noyau), ou null si elle est illisible. */
const siteDe = (brute: string) => {
  try {
    return siteMenage(new URL(brute).hostname);
  } catch {
    return null;
  }
};

const hoteDe = (brute: string) => {
  try {
    return new URL(brute).hostname;
  } catch {
    return "?";
  }
};

export interface DepsLecture {
  etat: () => EtatNavigateur;
  /** La session d'un profil de connexion (SessionsProfils.session), partagée avec les onglets de ce profil. */
  sessionProfil: (id: IdProfil) => Session;
  /** Par défaut, la session `webaios-lecture-publique`. */
  sessionPublique?: () => Session;
  /** Par défaut, une fenêtre cachée verrouillée (voir `creerFenetre`). */
  creerFenetre?: (s: Session) => BrowserWindow;
}

let publique: Session | undefined;

/** La session publique, verrouillée une fois : elle n'est qu'à ces lectures, tout y est refusé. */
function sessionLecturePublique(): Session {
  if (!publique) {
    const s = session.fromPartition(PARTITION_PUBLIQUE);
    s.setPermissionRequestHandler((_wc, _permission, rappel) => rappel(false));
    s.setPermissionCheckHandler(() => false);
    s.setDevicePermissionHandler(() => false);
    s.on("will-download", (e, item) => {
      e.preventDefault();
      item.cancel();
    });
    publique = s;
  }
  return publique;
}

/**
 * Une fenêtre jamais montrée : bac à sable, aucun preload, son coupé, ni nouvelle fenêtre, ni webview, ni boîte de
 * dialogue. Marquée invisible : dans la session d'un profil, autorisations et téléchargements lui sont refusés
 * (Permissions.brancher, will-download de index.ts) sans toucher aux gestionnaires de la session.
 */
function creerFenetre(s: Session): BrowserWindow {
  const f = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    focusable: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      session: s,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false,
      spellcheck: false,
      disableDialogs: true,
      autoplayPolicy: "document-user-activation-required",
    },
  });
  const wc = f.webContents;
  marquerInvisible(wc);
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-attach-webview", (e) => e.preventDefault());
  return f;
}

// Deux lectures au plus en même temps ; une place rendue passe directement à la suivante. Une lecture abandonnée
// (`signal` levé) pendant qu'elle attend quitte la file sans prendre de place.
let enCours = 0;
const file: (() => void)[] = [];
async function prendrePlace(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (enCours < LECTURES_SIMULTANEES) {
    enCours++;
    return;
  }
  await new Promise<void>((ok, ko) => {
    const servir = () => {
      signal?.removeEventListener("abort", quitter);
      ok();
    };
    const quitter = () => {
      const i = file.indexOf(servir);
      if (i >= 0) file.splice(i, 1);
      ko(signal!.reason);
    };
    file.push(servir);
    signal?.addEventListener("abort", quitter, { once: true });
  });
}
function rendrePlace(): void {
  const suivante = file.shift();
  if (suivante) suivante();
  else enCours--;
}

/** Comme `p`, mais rejetée avec `signal.reason` dès que le signal est levé (`p` continue, son issue est ignorée). */
function jusquAuSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((ok, ko) => {
    const stop = () => ko(signal.reason);
    p.then(ok, ko).finally(() => signal.removeEventListener("abort", stop));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Ce qu'une lecture lit dans la page : le script (monde isolé 999) et la mise en forme de ce qu'il rend. */
interface Lecture<T> {
  script: string;
  forme: (url: string, brut: unknown) => T;
}

/**
 * Charge `url` dans une fenêtre invisible (session publique vidée si `profil` est null, sinon celle d'un profil de
 * connexion qu'aucun espace privé n'utilise : sinon ProfilRefuse, sans rien créer) et la lit avec `lecture`. Une seule
 * fonction de chargement pour toutes les lectures : mêmes gardes, mêmes deux places, même limite de 30 s.
 * `signal` levé (l'exécution qui lit est arrêtée) : la lecture, en attente d'une place ou en cours, est abandonnée,
 * sa fenêtre fermée, et la promesse rejetée avec `signal.reason`.
 */
async function lireFenetre<T>(
  url: string,
  o: OptionsLecturePage,
  deps: DepsLecture,
  lecture: Lecture<T>,
): Promise<T> {
  const { profil, domaines, signal } = o;
  const permise = (u: string) => urlPermise(u, domaines, o.adressesLocales === true);
  const verifierProfil = () => {
    if (profil !== null && !profilsLisibles(deps.etat()).includes(profil)) throw new ProfilRefuse(profil);
  };
  verifierProfil();
  if (!permise(url)) throw new Error(`Adresse refusée pour une lecture : ${hoteDe(url)}`);
  let cible = url;
  /** Fin des 30 s, fixée au premier chargement : les redirections ménagées et leurs attentes y comptent. */
  let echeance: number | null = null;
  for (let sauts = 0; ; sauts++) {
    const premiere = sauts === 0;
    let redirection: string;
    await prendrePlace(signal);
    try {
      // L'échéance a pu passer pendant l'attente d'une place (après un saut) : aucune fenêtre pour rien.
      if (echeance !== null && Date.now() >= echeance) throw new Error(TROP_LENTE);
      // L'état a pu changer pendant l'attente d'une place.
      verifierProfil();
      signal?.throwIfAborted();
      let s: Session;
      if (profil === null) {
        s = (deps.sessionPublique ?? sessionLecturePublique)();
        // Vidée une seule fois : après une redirection ménagée, la page cible voit les cookies posés par le
        // redirecteur, comme une redirection ordinaire.
        if (premiere) {
          await jusquAuSignal(s.clearStorageData(), signal);
          await jusquAuSignal(s.clearCache(), signal);
        }
      } else {
        s = deps.sessionProfil(profil);
      }
      const f = (deps.creerFenetre ?? creerFenetre)(s);
      try {
        await jusquAuSignal(neutraliserImpression(f.webContents), signal);
        echeance ??= Date.now() + DELAI_TOTAL_MS;
        const page = await lireDans(f.webContents, cible, permise, lecture, echeance, signal, o.changerHote, ecrans(o.defiler));
        // Le profil est passé à un espace privé pendant la lecture : ce qui a été lu ne sort pas.
        verifierProfil();
        return page;
      } catch (e) {
        if (!(e instanceof Redirection)) throw e;
        redirection = e.cible;
      } finally {
        if (!f.isDestroyed()) {
          try {
            if (f.webContents.debugger.isAttached()) f.webContents.debugger.detach();
          } catch {
            // La fenêtre est détruite juste après : le débogueur part avec elle.
          }
          f.destroy();
        }
      }
    } finally {
      rendrePlace();
    }
    // Redirection vers un autre site (lecture ménagée) : son tour est attendu sans fenêtre ni place, sinon deux
    // lectures redirigées vers le site d'une troisième, qui attend une place, bloqueraient toutes les lectures.
    // Une boucle entre sites (A ⇄ B) échoue vite, comme la limite de redirections de Chromium.
    if (sauts >= MAX_SAUTS) throw new Error("Trop de redirections");
    await jusquAEcheance(o.changerHote!(new URL(redirection).hostname), echeance!, signal);
    cible = redirection;
  }
}

/** Une navigation vers un autre site, arrêtée pour attendre son tour (lecture ménagée) : à reprendre sur `cible`. */
class Redirection extends Error {
  constructor(readonly cible: string) {
    super(`Redirection vers ${hoteDe(cible)}`);
  }
}

/** `p`, rejetée avec « Page trop lente » à `echeance` et avec `signal.reason` s'il est levé (son issue est alors ignorée). */
function jusquAEcheance<T>(p: Promise<T>, echeance: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((ok, ko) => {
    const minuterie = setTimeout(() => ko(new Error(TROP_LENTE)), Math.max(0, echeance - Date.now()));
    jusquAuSignal(p, signal)
      .then(ok, ko)
      .finally(() => clearTimeout(minuterie));
  });
}

/**
 * Lit une page dans une fenêtre invisible, publique (`profil: null`) ou avec un profil de connexion qu'aucun espace
 * privé n'utilise (sinon ProfilRefuse, sans rien créer). Rien n'en est retenu : ni historique, ni onglet dans l'état.
 * Avec `domaines`, toute navigation du cadre principal hors de ces hôtes est annulée avant de partir, et la lecture échoue.
 * Avec `changerHote` (lecture ménagée), une navigation du cadre principal vers un autre site est retenue jusqu'à ce que
 * le ménagement de ce site le permette, puis reprise.
 */
export function lirePageInvisible(url: string, o: OptionsLecturePage, deps: DepsLecture): Promise<PageLue> {
  const bornes = ecrans(o.defiler) > 0 ? { texte: MAX_TEXTE_DEFILEE, liens: MAX_LIENS_DEFILEE } : { texte: MAX_TEXTE, liens: MAX_LIENS };
  return lireFenetre(url, o, deps, {
    script: lecturePage(bornes),
    forme: (u, brut) => mettreEnForme(u, (brut ?? { titre: "", texte: "", liens: [] }) as PartiesLues, bornes),
  });
}

/** Le nombre d'écrans à faire défiler : un entier de 0 à 20 (toute autre valeur : 0, la lecture d'avant). */
function ecrans(defiler: unknown): number {
  return typeof defiler === "number" && Number.isInteger(defiler) && defiler > 0 ? Math.min(defiler, DEFILER_MAX) : 0;
}

/**
 * Le HTML d'une page publique (`document.documentElement.outerHTML`, coupé à 2 Mo) : toujours la session publique,
 * vidée avant la lecture, jamais un profil. Lu dans le monde isolé 999 ; `url` est l'adresse finale (permise).
 */
export function lireHtmlInvisible(
  url: string,
  o: { adressesLocales?: boolean; signal?: AbortSignal },
  deps: DepsLecture,
): Promise<{ url: string; html: string }> {
  const options = { profil: null, ...(o.adressesLocales === true ? { adressesLocales: true } : {}), ...(o.signal ? { signal: o.signal } : {}) };
  return lireFenetre(url, options, deps, {
    script: LECTURE_HTML,
    forme: (u, brut) => ({ url: u, html: typeof brut === "string" ? brut.slice(0, HTML_MAX) : "" }),
  });
}

interface PartiesLues {
  titre: unknown;
  texte: unknown;
  liens: unknown;
}

interface Bornes {
  texte: number;
  liens: number;
}

/** Lu dans le monde isolé 999 : la page ne peut ni remplacer ces fonctions ni falsifier le résultat. */
const lecturePage = (b: Bornes) => `(() => {
  const vus = new Set();
  const liens = [];
  for (const a of document.querySelectorAll("a[href]")) {
    if (liens.length >= ${b.liens}) break;
    const url = a.href;
    if (typeof url !== "string" || !/^https?:/i.test(url) || vus.has(url)) continue;
    vus.add(url);
    liens.push({ texte: (a.innerText || a.textContent || "").replace(/\\s+/g, " ").trim(), url });
  }
  return { titre: document.title, texte: (document.body?.innerText ?? "").slice(0, ${b.texte}), liens };
})()`;

/**
 * Dans le monde isolé 999 : la hauteur de la page avant de défiler, puis un défilement d'un écran. Jamais de clic, de
 * frappe ni de focus ; la page voit un défilement ordinaire (événement `scroll`, IntersectionObserver).
 */
const DEFILEMENT = `(() => {
  const el = document.scrollingElement || document.documentElement;
  const hauteur = el ? el.scrollHeight : 0;
  const ecran = window.innerHeight || 900;
  if (el) el.scrollBy(0, ecran); else window.scrollBy(0, ecran);
  return { hauteur };
})()`;

/** Dans le monde isolé 999 : la hauteur de la page, et si le bas de l'écran l'atteint. */
const MESURE = `(() => {
  const el = document.scrollingElement || document.documentElement;
  if (!el) return { hauteur: 0, bas: true };
  return { hauteur: el.scrollHeight, bas: el.scrollTop + (window.innerHeight || el.clientHeight) >= el.scrollHeight - 2 };
})()`;

/** Le HTML entier de la page, lu dans le monde isolé 999. */
const LECTURE_HTML = `(() => document.documentElement.outerHTML)()`;

/** Remet en forme ce que le script a lu : la page a pu tout influencer, sauf les types et les bornes. */
function mettreEnForme(url: string, p: PartiesLues, b: Bornes): PageLue {
  const liens: PageLue["liens"] = [];
  const vus = new Set<string>();
  for (const l of Array.isArray(p.liens) ? (p.liens as unknown[]) : []) {
    if (liens.length >= b.liens) break;
    const brut = (l as { url?: unknown; texte?: unknown } | null) ?? {};
    const lien = typeof brut.url === "string" ? brut.url : "";
    if (!/^https?:\/\//i.test(lien) || vus.has(lien)) continue;
    vus.add(lien);
    liens.push({ texte: String(brut.texte ?? "").replace(/\s+/g, " ").trim(), url: lien });
  }
  return { url, titre: String(p.titre ?? ""), texte: String(p.texte ?? "").slice(0, b.texte), liens };
}

/** Rend `window.print` inopérant : sinon il suspend la page en attendant un panneau d'impression jamais montré. */
const SANS_IMPRESSION = `(() => {
  try { Object.defineProperty(window, "print", { value: () => {}, writable: false, configurable: false }); } catch {}
})()`;
const DELAI_PREPARATION_MS = 5_000;

/**
 * Avant tout script de la page, dans tous ses cadres (même d'un autre site, dans un autre processus) : `window.print`
 * remplacé, par le protocole DevTools de cette seule page. Les cadres attendent le débogueur à leur création, le temps
 * de recevoir le script. Le débogueur ne répond qu'après un premier chargement : d'où `about:blank`. Un échec fait
 * échouer la lecture. Vérifié à la main (Electron 45) : sans cela, `print()` bloque le rendu de la page, cadre ou non.
 */
async function neutraliserImpression(wc: WebContents): Promise<void> {
  let minuterie: NodeJS.Timeout | undefined;
  const delai = new Promise<never>((_ok, ko) => {
    minuterie = setTimeout(() => ko(new Error("Préparation de la page impossible")), DELAI_PREPARATION_MS);
  });
  try {
    await Promise.race([preparer(wc), delai]);
  } finally {
    clearTimeout(minuterie);
  }
}

async function preparer(wc: WebContents): Promise<void> {
  await wc.loadURL("about:blank");
  const d = wc.debugger;
  d.attach("1.3");
  const cible = async (sessionId?: string) => {
    await d.sendCommand("Page.enable", {}, sessionId);
    await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: SANS_IMPRESSION }, sessionId);
    await d.sendCommand("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  };
  d.on("message", (_e, methode, params: { sessionId?: string }) => {
    if (methode !== "Target.attachedToTarget" || !params.sessionId) return;
    const id = params.sessionId;
    cible(id)
      .catch(() => {})
      .finally(() => void d.sendCommand("Runtime.runIfWaitingForDebugger", {}, id).catch(() => {}));
  });
  await cible();
}

/**
 * Charge `url`, attend la fin du chargement puis 2 s de calme (jusqu'à `echeance` au plus), lit la page ; `signal`
 * levé : abandon. Avec `defiler` > 0, après ce calme, la page est défilée d'un écran à la fois (voir `defilerPuisLire`)
 * avant d'être lue. Avec `changerHote` (lecture ménagée), une navigation permise du cadre principal vers un autre site
 * (`siteMenage`) est annulée et la promesse rejetée avec `Redirection` : l'appelant ferme la fenêtre, attend le tour de
 * ce site, puis reprend la lecture sur la cible dans une nouvelle fenêtre.
 */
function lireDans<T>(
  wc: WebContents,
  url: string,
  permise: (u: string) => boolean,
  lecture: Lecture<T>,
  echeance: number,
  signal?: AbortSignal,
  changerHote?: ChangerHote,
  defiler = 0,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let fini = false;
    let charge = false;
    let enLecture = false;
    /** Un chargement en cours (cadre principal ou non) : l'attente après un défilement ne finit pas pendant. */
    let enChargement = false;
    const site = siteDe(url);
    const heureForcee = echeance - MARGE_LECTURE_FORCEE_MS;
    let calme: NodeJS.Timeout | undefined;
    /** La pause en cours du défilement, et de quoi la finir tout de suite (à la fin de la lecture). */
    let pause: NodeJS.Timeout | undefined;
    let reveil: (() => void) | undefined;
    const finir = (r: { erreur: Error } | { page: T }) => {
      if (fini) return;
      fini = true;
      clearTimeout(calme);
      clearTimeout(forcee);
      clearTimeout(limite);
      clearTimeout(pause);
      reveil?.();
      signal?.removeEventListener("abort", abandonner);
      if ("erreur" in r) reject(r.erreur);
      else resolve(r.page);
    };
    const arreterPage = (erreur: Error) => {
      finir({ erreur });
      // Jamais dans le gestionnaire d'un événement de navigation ; la fenêtre est de toute façon détruite ensuite.
      setImmediate(() => {
        if (!wc.isDestroyed()) wc.stop();
      });
    };
    const bloquer = (cible: string) => arreterPage(new Error(`Navigation bloquée : ${hoteDe(cible)} est hors des domaines permis`));
    // L'exécution qui lit est arrêtée : plus rien n'est lu, la fenêtre est fermée par l'appelant.
    const abandonner = () => arreterPage(signal!.reason);
    /** Vers un autre site, en lecture ménagée : la lecture s'arrête ici, reprise sur la cible à son tour. */
    const menager = (e: { preventDefault(): void }, cible: string) => {
      const autre = siteDe(cible);
      if (!changerHote || autre === null || autre === site) return;
      e.preventDefault();
      // Une seule redirection retenue : la première ; toute navigation suivante de cette page est sans suite.
      if (fini) return;
      arreterPage(new Redirection(cible));
    };
    // Avant que la requête parte : redirection du serveur, script, meta refresh, formulaire, lien.
    const garder = (e: { preventDefault(): void }, cible: string) => {
      if (permise(cible)) return menager(e, cible);
      e.preventDefault();
      bloquer(cible);
    };
    wc.on("will-navigate", (e) => garder(e, e.url));
    wc.on("will-redirect", (e) => {
      if (e.isMainFrame) garder(e, e.url);
    });
    // Filet : toute autre navigation du cadre principal hors des domaines arrête la lecture.
    wc.on("did-start-navigation", (e) => {
      if (e.isMainFrame && !e.isSameDocument && !permise(e.url)) bloquer(e.url);
    });
    // Le calme : 2 s sans chargement en cours, une fois le cadre principal chargé. Un cadre qui charge tard (publicité,
    // mesure d'audience) suspend l'attente, qui reprend quand plus rien ne charge.
    const attendreCalme = () => {
      clearTimeout(calme);
      calme = setTimeout(() => void (defiler > 0 ? defilerPuisLire() : lire()), CALME_MS);
    };
    wc.on("did-start-loading", () => {
      enChargement = true;
      clearTimeout(calme);
    });
    wc.on("did-stop-loading", () => {
      enChargement = false;
      if (charge) attendreCalme();
    });
    wc.on("did-finish-load", () => {
      charge = true;
      // L'heure de la lecture forcée est déjà passée (page lente, ou saut commencé près de l'échéance) : lue telle quelle.
      if (Date.now() >= heureForcee) return void lire();
      attendreCalme();
    });
    wc.on("did-fail-load", (_e, code, description, _url, principal) => {
      if (principal && code !== ERR_ABORTED) finir({ erreur: new Error(`Page non chargée : ${description || code}`) });
    });
    wc.on("render-process-gone", () => finir({ erreur: new Error("La page s'est arrêtée pendant la lecture") }));

    /** Lit la page tout de suite, une seule fois (calme, lecture forcée). */
    const lire = async () => {
      if (fini || enLecture || wc.isDestroyed()) return;
      enLecture = true;
      clearTimeout(calme);
      await lireMaintenant();
    };
    const lireMaintenant = async () => {
      if (fini || wc.isDestroyed()) return;
      try {
        const avant = wc.getURL();
        if (!permise(avant)) return bloquer(avant);
        const brut = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: lecture.script }]);
        // pushState/replaceState (application d'une page) a pu changer l'URL : elle doit rester permise.
        const apres = wc.isDestroyed() ? "" : wc.getURL();
        if (!permise(apres)) return bloquer(apres);
        finir({ page: lecture.forme(apres, brut) });
      } catch (e) {
        finir({ erreur: e instanceof Error ? e : new Error(String(e)) });
      }
    };

    const dormir = (ms: number) =>
      new Promise<void>((ok) => {
        reveil = ok;
        pause = setTimeout(ok, ms);
      });
    /** Ce que rend un script de défilement ou de mesure : la page a pu l'influencer, seuls les types comptent. */
    const mesurer = async (code: string): Promise<{ hauteur: number; bas: boolean }> => {
      const brut = (await wc.executeJavaScriptInIsolatedWorld(999, [{ code }])) as { hauteur?: unknown; bas?: unknown } | null;
      return { hauteur: typeof brut?.hauteur === "number" ? brut.hauteur : 0, bas: brut?.bas === true };
    };
    /**
     * Après le premier calme : défile d'un écran (monde isolé 999), attend que la page ne grandisse plus depuis 1 s
     * sans chargement en cours, et recommence, jusqu'à `defiler` écrans, jusqu'au bas d'une page qui n'a plus grandi,
     * ou jusqu'à l'heure de la lecture forcée ; puis lit. Les gardes de navigation et le signal restent actifs : ils
     * finissent la lecture (`fini`), et la boucle s'arrête à son pas suivant.
     */
    const defilerPuisLire = async () => {
      if (fini || enLecture || wc.isDestroyed()) return;
      enLecture = true;
      clearTimeout(calme);
      try {
        for (let n = 0; n < defiler && Date.now() < heureForcee; n++) {
          const ici = wc.getURL();
          if (!permise(ici)) return bloquer(ici);
          const { hauteur: avant } = await mesurer(DEFILEMENT);
          let mesure = { hauteur: avant, bas: false };
          let hauteur = -1;
          let depuis = Date.now();
          for (;;) {
            if (fini || wc.isDestroyed()) return;
            mesure = await mesurer(MESURE);
            if (fini) return;
            const maintenant = Date.now();
            if (mesure.hauteur !== hauteur || enChargement) {
              hauteur = mesure.hauteur;
              depuis = maintenant;
            }
            if (maintenant >= heureForcee || maintenant - depuis >= CALME_DEFILEMENT_MS) break;
            await dormir(Math.min(RELEVE_MS, heureForcee - maintenant));
          }
          // Le bas est atteint et rien n'a chargé : défiler encore n'apporterait rien.
          if (mesure.bas && mesure.hauteur <= avant) break;
        }
      } catch {
        // Un script de défilement a échoué (la page navigue, le document a changé) : plus de défilement, la page est
        // lue au calme suivant, ou à la lecture forcée, comme sans `defiler`.
        if (fini) return;
        defiler = 0;
        enLecture = false;
        if (charge && !enChargement) attendreCalme();
        return;
      }
      await lireMaintenant();
    };
    const forcee = setTimeout(() => {
      if (charge) void lire();
    }, Math.max(0, heureForcee - Date.now()));
    const limite = setTimeout(() => finir({ erreur: new Error(TROP_LENTE) }), Math.max(0, echeance - Date.now()));
    if (signal?.aborted) return abandonner();
    signal?.addEventListener("abort", abandonner, { once: true });
    // Les échecs arrivent par did-fail-load (ou par le blocage) ; la promesse de loadURL n'apporte rien de plus.
    wc.loadURL(url).catch(() => {});
  });
}
