import { adresseLocale, hoteDansSite } from "@webaios/noyau";

/**
 * Domaines effectifs de l'appli, et ceux de sa connexion (OAuth…). `adressesLocales` (tests seulement,
 * `WEBAIOS_TEST_ADRESSES_LOCALES=1`) permet les hôtes locaux, et http vers eux ; sinon https seul, jamais local.
 */
export type ContexteNavigation = { domaines: readonly string[]; connexion: readonly string[]; adressesLocales?: boolean };

/**
 * L'hôte d'une adresse web permise, ou null : javascript:, about:blank, file:, adresse illisible, identifiants dans
 * l'adresse, http hors mode test, hôte local hors mode test (défense en profondeur : les listes sont déjà vérifiées).
 */
function hoteWeb(url: string, adressesLocales: boolean): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const local = adresseLocale(u.hostname);
  if (local && !adressesLocales) return null;
  if (u.protocol === "https:") return u.hostname;
  return u.protocol === "http:" && local ? u.hostname : null;
}

/** Page principale : suivie vers le site ou sa connexion, bloquée ailleurs (mention dans la barre). */
export function decisionNavigation(url: string, c: ContexteNavigation): "suivre" | "bloquer" {
  const hote = hoteWeb(url, c.adressesLocales === true);
  return hote !== null && (hoteDansSite(hote, c.domaines) || hoteDansSite(hote, c.connexion)) ? "suivre" : "bloquer";
}

/**
 * `window.open` et `target=_blank` : vers le site, la vue de l'appli y va ; vers la connexion, une petite fenêtre de la
 * même session ; le reste (publicités, `about:blank` compris) est bloqué, jamais ouvert dans un onglet.
 */
export function decisionOuverture(url: string, c: ContexteNavigation): "dans-l-appli" | "petite-fenetre" | "bloquer" {
  const hote = hoteWeb(url, c.adressesLocales === true);
  if (hote === null) return "bloquer";
  if (hoteDansSite(hote, c.domaines)) return "dans-l-appli";
  return hoteDansSite(hote, c.connexion) ? "petite-fenetre" : "bloquer";
}
