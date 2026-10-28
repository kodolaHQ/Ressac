import { BrowserWindow, session, type Session, type WebContents } from "electron";
import { ProfilRefuse, type PageLue } from "@webaios/noyau";
import type { EtatNavigateur, IdProfil } from "../../commun/modele";
import { marquerInvisible } from "../contenus-invisibles";

/** Session des lectures publiques : sans `persist:`, rien n'est écrit sur le disque ; vidée avant chaque lecture. */
export const PARTITION_PUBLIQUE = "webaios-lecture-publique";
const DELAI_TOTAL_MS = 30_000;
/** Une page chargée encore en mouvement à ce moment est lue telle quelle, pour finir dans les 30 s. */
const DELAI_LECTURE_FORCEE_MS = 26_000;
const CALME_MS = 2_000;
const MAX_TEXTE = 20_000;
const MAX_LIENS = 400;
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
 * L'URL peut être chargée : http(s) seulement ; avec `domaines`, son hôte doit être l'un d'eux exactement, comme le
 * vérifie le noyau (packages/noyau/src/widgets/recolte.ts, `verifierUrl`) : un sous-domaine n'y est pas permis.
 */
export function urlPermise(brute: string, domaines: readonly string[] | undefined): boolean {
  let u: URL;
  try {
    u = new URL(brute);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return !domaines || domaines.map(normaliser).includes(normaliser(u.hostname));
}

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

// Deux lectures au plus en même temps ; une place rendue passe directement à la suivante.
let enCours = 0;
const file: (() => void)[] = [];
async function prendrePlace(): Promise<void> {
  if (enCours < LECTURES_SIMULTANEES) {
    enCours++;
    return;
  }
  await new Promise<void>((r) => file.push(r));
}
function rendrePlace(): void {
  const suivante = file.shift();
  if (suivante) suivante();
  else enCours--;
}

/**
 * Lit une page dans une fenêtre invisible, publique (`profil: null`) ou avec un profil de connexion qu'aucun espace
 * privé n'utilise (sinon ProfilRefuse, sans rien créer). Rien n'en est retenu : ni historique, ni onglet dans l'état.
 * Avec `domaines`, toute navigation du cadre principal hors de ces hôtes est annulée avant de partir, et la lecture échoue.
 */
export async function lirePageInvisible(url: string, o: { profil: string | null; domaines?: string[] }, deps: DepsLecture): Promise<PageLue> {
  const { profil, domaines } = o;
  const verifierProfil = () => {
    if (profil !== null && !profilsLisibles(deps.etat()).includes(profil)) throw new ProfilRefuse(profil);
  };
  verifierProfil();
  if (!urlPermise(url, domaines)) throw new Error(`Adresse refusée pour une lecture : ${hoteDe(url)}`);
  await prendrePlace();
  try {
    // L'état a pu changer pendant l'attente d'une place.
    verifierProfil();
    let s: Session;
    if (profil === null) {
      s = (deps.sessionPublique ?? sessionLecturePublique)();
      await s.clearStorageData();
      await s.clearCache();
    } else {
      s = deps.sessionProfil(profil);
    }
    const f = (deps.creerFenetre ?? creerFenetre)(s);
    try {
      const page = await lireDans(f.webContents, url, domaines);
      // Le profil est passé à un espace privé pendant la lecture : ce qui a été lu ne sort pas.
      verifierProfil();
      return page;
    } finally {
      if (!f.isDestroyed()) f.destroy();
    }
  } finally {
    rendrePlace();
  }
}

interface PartiesLues {
  titre: unknown;
  texte: unknown;
  liens: unknown;
}

/** Lu dans le monde isolé 999 : la page ne peut ni remplacer ces fonctions ni falsifier le résultat. */
const LECTURE = `(() => {
  const vus = new Set();
  const liens = [];
  for (const a of document.querySelectorAll("a[href]")) {
    if (liens.length >= ${MAX_LIENS}) break;
    const url = a.href;
    if (typeof url !== "string" || !/^https?:/i.test(url) || vus.has(url)) continue;
    vus.add(url);
    liens.push({ texte: (a.innerText || a.textContent || "").replace(/\\s+/g, " ").trim(), url });
  }
  return { titre: document.title, texte: (document.body?.innerText ?? "").slice(0, ${MAX_TEXTE}), liens };
})()`;

/** Remet en forme ce que le script a lu : la page a pu tout influencer, sauf les types et les bornes. */
function mettreEnForme(url: string, p: PartiesLues): PageLue {
  const liens: PageLue["liens"] = [];
  const vus = new Set<string>();
  for (const l of Array.isArray(p.liens) ? (p.liens as unknown[]) : []) {
    if (liens.length >= MAX_LIENS) break;
    const brut = (l as { url?: unknown; texte?: unknown } | null) ?? {};
    const lien = typeof brut.url === "string" ? brut.url : "";
    if (!urlPermise(lien, undefined) || vus.has(lien)) continue;
    vus.add(lien);
    liens.push({ texte: String(brut.texte ?? "").replace(/\s+/g, " ").trim(), url: lien });
  }
  return { url, titre: String(p.titre ?? ""), texte: String(p.texte ?? "").slice(0, MAX_TEXTE), liens };
}

/** Charge `url`, attend la fin du chargement puis 2 s de calme (30 s au plus), lit la page. */
function lireDans(wc: WebContents, url: string, domaines: readonly string[] | undefined): Promise<PageLue> {
  return new Promise<PageLue>((resolve, reject) => {
    let fini = false;
    let charge = false;
    let lecture = false;
    let calme: NodeJS.Timeout | undefined;
    const finir = (r: { erreur: Error } | { page: PageLue }) => {
      if (fini) return;
      fini = true;
      clearTimeout(calme);
      clearTimeout(forcee);
      clearTimeout(limite);
      if ("erreur" in r) reject(r.erreur);
      else resolve(r.page);
    };
    const bloquer = (cible: string) => {
      finir({ erreur: new Error(`Navigation bloquée : ${hoteDe(cible)} est hors des domaines permis`) });
      if (!wc.isDestroyed()) wc.stop();
    };
    // Avant que la requête parte : redirection du serveur, script, meta refresh, formulaire, lien.
    const garder = (e: { preventDefault(): void }, cible: string) => {
      if (urlPermise(cible, domaines)) return;
      e.preventDefault();
      bloquer(cible);
    };
    wc.on("will-navigate", (e) => garder(e, e.url));
    wc.on("will-redirect", (e) => {
      if (e.isMainFrame) garder(e, e.url);
    });
    // Filet : toute autre navigation du cadre principal hors des domaines arrête la lecture.
    wc.on("did-start-navigation", (e) => {
      if (e.isMainFrame && !e.isSameDocument && !urlPermise(e.url, domaines)) bloquer(e.url);
    });
    wc.on("did-start-loading", () => clearTimeout(calme));
    wc.on("did-finish-load", () => {
      charge = true;
      clearTimeout(calme);
      calme = setTimeout(() => void lire(), CALME_MS);
    });
    wc.on("did-fail-load", (_e, code, description, _url, principal) => {
      if (principal && code !== ERR_ABORTED) finir({ erreur: new Error(`Page non chargée : ${description || code}`) });
    });
    wc.on("render-process-gone", () => finir({ erreur: new Error("La page s'est arrêtée pendant la lecture") }));

    const lire = async () => {
      if (fini || lecture || wc.isDestroyed()) return;
      lecture = true;
      clearTimeout(calme);
      try {
        const avant = wc.getURL();
        if (!urlPermise(avant, domaines)) return bloquer(avant);
        const parties = (await wc.executeJavaScriptInIsolatedWorld(999, [{ code: LECTURE }])) as PartiesLues;
        const apres = wc.isDestroyed() ? "" : wc.getURL();
        if (apres !== avant) throw new Error("La page a changé pendant la lecture");
        finir({ page: mettreEnForme(apres, parties ?? { titre: "", texte: "", liens: [] }) });
      } catch (e) {
        finir({ erreur: e instanceof Error ? e : new Error(String(e)) });
      }
    };
    const forcee = setTimeout(() => {
      if (charge) void lire();
    }, DELAI_LECTURE_FORCEE_MS);
    const limite = setTimeout(() => finir({ erreur: new Error("Page trop lente : 30 s dépassées") }), DELAI_TOTAL_MS);
    // Les échecs arrivent par did-fail-load (ou par le blocage) ; la promesse de loadURL n'apporte rien de plus.
    wc.loadURL(url).catch(() => {});
  });
}
