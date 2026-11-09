import { domainToASCII } from "node:url";
import { adresseLocale } from "../workflows/acces.js";
import { domaineVrai, type DeclarationSite, type Retouche } from "./schemas.js";

/** The app's domains, never in site.json: the current one, and the old ones that must still be recognized. */
export type EtatAdresse = { actuel: string; anciens: string[]; depuis: string | null };

const HOTE_VALIDE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/** Lowercase, trailing dot removed, Unicode converted to ASCII (punycode); "" if the name is invalid. */
const nettoyer = (h: string) => {
  const b = h.toLowerCase().replace(/\.+$/, "");
  if (/[\/@:?#\s%\\*\[\]]/.test(b)) return "";
  const a = /^[a-z0-9.-]*$/.test(b) ? b : domainToASCII(b);
  return HOTE_VALIDE.test(a) ? a : "";
};

/** https, or (tests) http of a local host; never credentials. */
function schemaAccepte(u: URL, adressesLocales: boolean): boolean {
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && adressesLocales && adresseLocale(u.hostname);
}

/** Exact or subdomain, case-insensitive, trailing dot removed. */
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

/** The declared address, whose host is replaced by the current address when the site changed domain. */
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

/** Path + query (without #) if the host is in the site, otherwise null. */
export function adresseRelative(url: string, domaines: readonly string[]): string | null {
  const u = analyser(url);
  if (!u || !hoteDansSite(u.hostname, domaines)) return null;
  return u.pathname + u.search;
}

/**
 * A relative address (« /… », never « //… ») or absolute on a domain of the site, rendered on the current domain with the
 * scheme and port of the start address. Everything else is refused.
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
  // An invalid `actuel` leaves the start host.
  const n = nettoyer(actuel);
  const valide = HOTE_VALIDE.test(n) && (o.adressesLocales || !adresseLocale(n));
  const hoteSortie = valide ? n : base.hostname;
  let u: URL;
  if (adresse.startsWith("/")) {
    if (adresse.startsWith("//") || adresse.startsWith("/\\")) return null;
    const r = analyser(`${base.protocol}//${base.host}${adresse}`);
    if (!r || nettoyer(r.hostname) !== nettoyer(base.hostname)) return null;
    u = r;
  } else {
    const r = analyser(adresse);
    if (!r || !hoteDansSite(r.hostname, domaines) || !schemaAccepte(r, o.adressesLocales)) return null;
    u = r;
  }
  const sortie = analyser(`${base.protocol}//${base.host}${u.pathname}${u.search}${u.hash}`);
  if (!sortie) return null;
  sortie.hostname = hoteSortie;
  // `actuel` in numeric notation (0x7f.1, 2130706433) is only normalized here: checked again, otherwise the start host.
  if (!o.adressesLocales && adresseLocale(sortie.hostname)) sortie.hostname = base.hostname;
  if (!schemaAccepte(sortie, o.adressesLocales)) return null;
  return sortie.href;
}

/**
 * Iterative glob matching (two pointers, O(n·m), no exponential backtracking). `*` = any sequence of characters
 * outside `interdits`.
 */
function glob(motif: string, texte: string, interdits = ""): boolean {
  let m = 0, t = 0, etoile = -1, reprise = 0;
  while (t < texte.length) {
    if (m < motif.length && motif[m] === "*") {
      etoile = m++;
      reprise = t;
    } else if (m < motif.length && motif[m] === texte[t]) {
      m++;
      t++;
    } else if (etoile >= 0 && !interdits.includes(texte[reprise]!)) {
      m = etoile + 1;
      t = ++reprise;
    } else return false;
  }
  while (m < motif.length && motif[m] === "*") m++;
  return m === motif.length;
}

/**
 * Wildcard `*` anchored at both ends. Path: case-sensitive. Full address: scheme, host and path compared
 * separately; a `*` in the host never passes `/ ? # @ :`; a URL with credentials is refused.
 */
export function correspondMotif(motif: string, texte: string): boolean {
  const complet = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is.exec(motif);
  if (!complet) return glob(motif, texte);
  const u = analyser(texte);
  if (!u || u.username || u.password) return false;
  const [, schema, hote, reste] = complet as unknown as [string, string, string, string];
  if (u.protocol !== `${schema.toLowerCase()}:`) return false;
  const hoteTexte = (nettoyer(u.hostname) || u.hostname) + (u.port ? `:${u.port}` : "");
  if (!glob(hote.toLowerCase(), hoteTexte, "/?#@:")) return false;
  return glob(reste === "" ? "/" : reste, u.pathname + u.search);
}

/** The tweaks that apply to a frame: main frame by path, subframe by full-address pattern. */
export function retouchesPour(
  d: DeclarationSite,
  cadre: { url: string; principal: boolean },
  domaines: readonly string[],
  o: { adressesLocales: boolean } = { adressesLocales: false },
): Retouche[] {
  const u = analyser(cadre.url);
  if (!u || !schemaAccepte(u, o.adressesLocales)) return [];
  if (cadre.principal) {
    const rel = adresseRelative(cadre.url, domaines);
    if (rel === null) return [];
    return d.retouches.filter((r) => r.correspond.some((m) => correspondMotif(m, rel)));
  }
  return d.retouches.filter((r) => r.cadres !== false && r.cadres.some((m) => correspondMotif(m, cadre.url)));
}

/**
 * The new address of a site according to the links of its reference page (hostile): the first https link whose host
 * contains the pattern, outside the reference page, its subdomains and its parent domain (same last two labels),
 * outside local addresses. `hostname` is clean (no port or trailing dot); `port` only exists in test mode.
 */
export function trouverAdresse(
  liens: readonly string[],
  o: { page: string; motif: string; adressesLocales: boolean },
): { hostname: string; origine: string; port: string | null } | null {
  const page = analyser(o.page);
  const motif = o.motif.toLowerCase();
  if (!page || !motif) return null;
  const deux = (h: string) => h.split(".").slice(-2).join(".");
  const hotePage = nettoyer(page.hostname);
  for (const lien of liens) {
    const u = analyser(lien);
    if (!u || !schemaAccepte(u, o.adressesLocales)) continue;
    const h = nettoyer(u.hostname);
    if (!h || !HOTE_VALIDE.test(h) || !h.includes(motif) || deux(h) === deux(hotePage)) continue;
    if (!domaineVrai(h, o.adressesLocales)) continue;
    const port = o.adressesLocales && u.port ? u.port : null;
    return { hostname: h, origine: `${u.protocol}//${h}${port ? `:${port}` : ""}/`, port };
  }
  return null;
}
