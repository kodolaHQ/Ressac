import { hoteDansSite } from "@webaios/noyau";

/** Domaines effectifs de l'appli, et ceux de sa connexion (OAuth…). */
export type ContexteNavigation = { domaines: readonly string[]; connexion: readonly string[] };

/** Codes `did-fail-load` du cadre principal qui font chercher la nouvelle adresse (DNS, connexion refusée, coupée…). */
export const ERREURS_RESEAU_SUIVI: readonly number[] = [-7, -100, -101, -102, -104, -105, -106, -109, -118, -137];

/** L'hôte d'une adresse http(s), ou null (javascript:, about:blank, file:, adresse illisible…). */
function hoteWeb(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === "https:" || u.protocol === "http:" ? u.hostname : null;
}

/** Page principale : suivie vers le site ou sa connexion, bloquée ailleurs (mention dans la barre). */
export function decisionNavigation(url: string, c: ContexteNavigation): "suivre" | "bloquer" {
  const hote = hoteWeb(url);
  return hote !== null && (hoteDansSite(hote, c.domaines) || hoteDansSite(hote, c.connexion)) ? "suivre" : "bloquer";
}

/**
 * `window.open` et `target=_blank` : vers le site, la vue de l'appli y va ; vers la connexion, une petite fenêtre de la
 * même session ; le reste (publicités, `about:blank` compris) est bloqué, jamais ouvert dans un onglet.
 */
export function decisionOuverture(url: string, c: ContexteNavigation): "dans-l-appli" | "petite-fenetre" | "bloquer" {
  const hote = hoteWeb(url);
  if (hote === null) return "bloquer";
  if (hoteDansSite(hote, c.domaines)) return "dans-l-appli";
  return hoteDansSite(hote, c.connexion) ? "petite-fenetre" : "bloquer";
}

/** Le site ne répond pas (et non : chargement abandonné, certificat refusé…). */
export const erreurDeReseau = (code: number): boolean => ERREURS_RESEAU_SUIVI.includes(code);
