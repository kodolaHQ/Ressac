import { adresseLocale } from "../workflows/acces.js";
import type { DeclarationSite, Retouche } from "./schemas.js";

/** Domaines de l'appli, jamais dans site.json : l'actuel, et les anciens qu'il faut encore reconnaître. */
export type EtatAdresse = { actuel: string; anciens: string[]; depuis: string | null };

const nettoyer = (h: string) => h.toLowerCase().replace(/\.+$/, "");

/** Exact ou sous-domaine, sans casse, point final retiré. */
export function hoteDansSite(hote: string, domaines: readonly string[]): boolean {
  const h = nettoyer(hote);
  if (!h) return false;
  return domaines.some((d) => {
    const n = nettoyer(d);
    return n !== "" && (h === n || h.endsWith(`.${n}`));
  });
}

export function domainesEffectifs(d: DeclarationSite, e: EtatAdresse | null): string[] {
  const tous = [...d.domaines, ...(e ? [...e.anciens, e.actuel] : [])].map(nettoyer);
  return [...new Set(tous)];
}

/** L'adresse déclarée, dont l'hôte est remplacé par l'adresse actuelle quand le site a changé de domaine. */
export function adresseDeDepart(d: DeclarationSite, e: EtatAdresse | null): string {
  if (!e) return d.adresse;
  let u: URL;
  try {
    u = new URL(d.adresse);
  } catch {
    return d.adresse;
  }
  if (hoteDansSite(u.hostname, [e.actuel])) return d.adresse;
  u.hostname = e.actuel;
  return u.href;
}

function analyser(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Chemin + requête (sans #) si l'hôte est dans le site, sinon null. */
export function adresseRelative(url: string, domaines: readonly string[]): string | null {
  const u = analyser(url);
  if (!u || !hoteDansSite(u.hostname, domaines)) return null;
  return u.pathname + u.search;
}

/**
 * Une adresse relative (« /… », jamais « //… ») ou absolue sur un domaine du site, rendue sur le domaine actuel avec le
 * schéma et le port de l'adresse de départ. Tout le reste est refusé.
 */
export function adresseSurDomaine(
  adresse: string,
  actuel: string,
  domaines: readonly string[],
  depart: string,
  o: { adressesLocales: boolean },
): string | null {
  const base = analyser(depart);
  if (!base) return null;
  let u: URL;
  if (adresse.startsWith("/")) {
    if (adresse.startsWith("//") || adresse.startsWith("/\\")) return null;
    const r = analyser(`${base.protocol}//${base.host}${adresse}`);
    if (!r || nettoyer(r.hostname) !== nettoyer(base.hostname)) return null;
    u = r;
  } else {
    const r = analyser(adresse);
    if (!r || !hoteDansSite(r.hostname, domaines)) return null;
    if (r.username || r.password) return null;
    if (r.protocol !== "https:" && !(o.adressesLocales && r.protocol === "http:")) return null;
    u = r;
  }
  const sortie = analyser(`${base.protocol}//${base.host}${u.pathname}${u.search}${u.hash}`);
  if (!sortie) return null;
  sortie.hostname = actuel;
  if (sortie.protocol !== "https:" && !(o.adressesLocales && sortie.protocol === "http:")) return null;
  return sortie.href;
}

/** Joker `*` (toute suite de caractères), ancré aux deux bouts, sensible à la casse sauf l'hôte d'une adresse complète. */
export function correspondMotif(motif: string, texte: string): boolean {
  const hote = (s: string) => s.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/]*)/i, (_, p: string, h: string) => p.toLowerCase() + h.toLowerCase());
  const m = hote(motif);
  const t = hote(texte);
  const re = new RegExp(`^${m.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
  return re.test(t);
}

/** Les retouches qui s'appliquent à un cadre : principal par chemin, sous-cadre par motif d'adresse complète. */
export function retouchesPour(
  d: DeclarationSite,
  cadre: { url: string; principal: boolean },
  domaines: readonly string[],
): Retouche[] {
  if (cadre.principal) {
    const rel = adresseRelative(cadre.url, domaines);
    if (rel === null) return [];
    return d.retouches.filter((r) => r.correspond.some((m) => correspondMotif(m, rel)));
  }
  return d.retouches.filter((r) => r.cadres !== false && r.cadres.some((m) => correspondMotif(m, cadre.url)));
}

/**
 * La nouvelle adresse d'un site d'après les liens de sa page de référence (hostile) : le premier lien https dont l'hôte
 * contient le motif, hors page de référence et ses sous-domaines, hors adresses locales. Rend son origine.
 */
export function trouverAdresse(
  liens: readonly string[],
  o: { page: string; motif: string; adressesLocales: boolean },
): string | null {
  const page = analyser(o.page);
  const motif = o.motif.toLowerCase();
  if (!page || !motif) return null;
  const hotePage = nettoyer(page.hostname);
  for (const lien of liens) {
    const u = analyser(lien);
    if (!u || u.username || u.password) continue;
    const h = nettoyer(u.hostname);
    if (!h.includes(motif) || hoteDansSite(h, [hotePage])) continue;
    const local = adresseLocale(h);
    if (u.protocol === "https:") {
      if (local && !o.adressesLocales) continue;
    } else if (!(u.protocol === "http:" && o.adressesLocales && local)) continue;
    return `${u.protocol}//${u.host}/`;
  }
  return null;
}
