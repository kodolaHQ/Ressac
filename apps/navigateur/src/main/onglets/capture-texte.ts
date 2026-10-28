import type { WebContents } from "electron";
import { TEXTE_MAX } from "../historique";
import type { ContexteHistorique } from "./evenements";

/** Délai entre la fin d'un chargement (ou un changement d'URL sans rechargement) et la lecture du texte. */
const DELAI_CAPTURE = 1500;

/**
 * Tests automatiques seulement : leur serveur est sur 127.0.0.1, dont la mémoire ne retient rien d'ordinaire. Lu une
 * fois au démarrage ; ne lève que l'exclusion des adresses locales.
 */
const BOUCLE_PERMISE = process.env.WEBAIOS_MEMOIRE_BOUCLE === "1";

const HOTES_LOCAUX = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** L'URL peut être retenue : http(s) seulement, hors adresses locales (sauf `boucle`, mode test). */
export function retenable(url: string, boucle = BOUCLE_PERMISE): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return boucle || !HOTES_LOCAUX.has(u.hostname);
}

export function estVideoYoutube(url: string): boolean {
  try {
    const u = new URL(url);
    return /^((www|m)\.)?youtube\.com$/.test(u.hostname) && u.pathname === "/watch";
  } catch {
    return false;
  }
}

/** Ce que le monde isolé lit dans la page. */
export interface PartiesPage {
  /** Description de la page (`meta[name=description]`). */
  description?: string;
  corps: string;
  /** Vidéo YouTube : seules ces parties sont gardées. */
  video?: { titre?: string; chaine?: string; description?: string };
}

/** Le texte retenu d'une page : ses parties non vides, séparées par une ligne vide. */
export function composerTexte(p: PartiesPage): string {
  const parties = p.video ? [p.video.titre, p.video.chaine, p.video.description] : [p.description, p.corps];
  return parties
    .map((s) => s?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

/** Lecture dans le monde isolé 999, comme `lireTexteDe` : la page ne peut pas falsifier ce qui est lu. */
const lecture = (video: boolean) => `(() => {
  const texte = (sel) => document.querySelector(sel)?.innerText ?? "";
  const description = document.querySelector('meta[name="description"]')?.content ?? "";
  if (${video}) return {
    corps: "",
    video: {
      titre: texte("h1.ytd-watch-metadata") || document.title,
      chaine: texte("ytd-watch-metadata #channel-name a") || texte("#owner #channel-name a"),
      description: texte("#description") || description,
    },
  };
  return { description, corps: (document.body?.innerText ?? "").slice(0, ${TEXTE_MAX}) };
})()`;

/**
 * Retient le texte des pages vues dans un onglet, environ 1,5 s après chaque chargement ou changement d'URL sans
 * rechargement. Rien n'est retenu d'un onglet disparu ou privé, d'une URL non retenable, d'une page en erreur ou
 * atteinte par une authentification HTTP. URL et espace sont relus au moment de la lecture : s'ils ont changé entre
 * temps, rien n'est retenu. Aucune erreur ne remonte.
 */
export function brancherCapture(
  wc: WebContents,
  contexte: ContexteHistorique,
  retenir: (r: { url: string; espaceId: string; titre: string; texte: string }) => void,
): void {
  let minuterie: NodeJS.Timeout | undefined;
  let erreur = false;
  let authentification = false;
  const annuler = () => {
    clearTimeout(minuterie);
    minuterie = undefined;
  };

  const capturer = async (url: string, espaceId: string) => {
    if (wc.isDestroyed() || wc.isCrashed() || erreur || authentification || wc.getURL() !== url) return;
    const c = contexte();
    if (!c || c.prive || c.espaceId !== espaceId) return;
    const parties = (await wc.executeJavaScriptInIsolatedWorld(999, [{ code: lecture(estVideoYoutube(url)) }])) as PartiesPage;
    // La page a pu changer pendant la lecture.
    const apres = contexte();
    if (wc.isDestroyed() || wc.getURL() !== url || !apres || apres.prive || apres.espaceId !== espaceId) return;
    const texte = composerTexte(parties);
    if (texte) retenir({ url, espaceId, titre: wc.getTitle() || url, texte });
  };

  const planifier = () => {
    annuler();
    const url = wc.getURL();
    const c = contexte();
    if (!c || c.prive || !retenable(url) || erreur || authentification) return;
    minuterie = setTimeout(() => {
      minuterie = undefined;
      capturer(url, c.espaceId).catch(() => {});
    }, DELAI_CAPTURE);
  };

  // Toute navigation annule la lecture prévue ; une nouvelle page efface les marques de la précédente.
  wc.on("did-start-navigation", (details) => {
    if (!details.isMainFrame) return;
    annuler();
    if (!details.isSameDocument) {
      erreur = false;
      authentification = false;
    }
  });
  wc.on("login", () => {
    authentification = true;
    annuler();
  });
  wc.on("did-fail-load", (_e, code, _description, _url, principal) => {
    if (principal && code !== -3) {
      erreur = true;
      annuler();
    }
  });
  wc.on("did-stop-loading", planifier);
  wc.on("did-navigate-in-page", (_e, _url, principal) => {
    if (principal) planifier();
  });
  wc.once("destroyed", annuler);
}
