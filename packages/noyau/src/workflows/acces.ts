import { isIP } from "node:net";
import type { PageLue } from "./protocole.js";

// Accès du conteneur au dehors, tous côté noyau : URL vérifiées, récupération brute, page lue revérifiée.

const RECUPERER_MAX_OCTETS = 5 * 1024 * 1024;
const RECUPERER_DELAI_MS = 20_000;
const MAX_REDIRECTIONS = 5;

/** Recherches web et lectures ouvertes (sans `domaines`) d'une exécution, au plus. */
export const MAX_RECHERCHES = 30;
export const MAX_LECTURES_OUVERTES = 100;
// Les deux premiers sont recopiés dans docker/moteur/erreurs.mjs : l'élément n'est pas lancé, ce n'est pas un échec.
export const PLAFOND_RECHERCHES = "Plafond de recherches atteint (30 par exécution)";
export const RECHERCHES_ARRETEES = "Recherches arrêtées : DuckDuckGo a refusé une recherche de cette exécution";
export const TROP_DE_LECTURES = "Trop de lectures dans cette exécution (100)";
export const RECHERCHE_INDISPONIBLE = "Recherche web indisponible";

/** Un texte de `n` caractères au plus, « … » à la fin s'il est coupé. */
export const tronquer = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** Le message d'une exception, ou sa valeur en texte. */
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Adresse de la machine ou du réseau local, écrite telle quelle dans l'URL (le nom n'est pas résolu). */
export function adresseLocale(hote: string): boolean {
  // « localhost. » (point final) désigne la même machine que « localhost ».
  const h = hote.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
  if (!h || h === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(h)) return true;
  if (isIP(h) === 4) {
    const [a = 0, b = 0] = h.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (isIP(h) === 6) {
    return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:") || h.startsWith("64:ff9b:");
  }
  return false;
}

/**
 * Vérifie une URL demandée par la récolte : http(s), sans identifiants, pas d'adresse locale, et, si `domaines` est
 * donné, un nom d'hôte exactement dans cette liste. Rend l'URL normalisée, celle qui sera lue.
 */
export function verifierUrl(brute: string, domaines: readonly string[] | null, adressesLocales: boolean): URL {
  let u: URL;
  try {
    u = new URL(brute);
  } catch {
    throw new Error(`URL invalide : ${tronquer(brute, 200)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Seules les URL http(s) sont permises");
  if (u.username || u.password) throw new Error("URL avec identifiants refusée");
  // Le point final (« app.daily.dev. ») ne change pas le nom : il est retiré avant toute comparaison.
  const hote = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (domaines && !domaines.includes(hote)) throw new Error(`Domaine non déclaré : ${hote}`);
  if (!adressesLocales && adresseLocale(hote)) throw new Error(`Adresse locale refusée : ${hote}`);
  return u;
}

async function lireCorps(r: Response): Promise<Buffer> {
  const annonce = Number(r.headers.get("content-length"));
  if (Number.isFinite(annonce) && annonce > RECUPERER_MAX_OCTETS) {
    await r.body?.cancel().catch(() => {});
    throw new Error("Réponse trop grande (5 Mo maximum)");
  }
  if (!r.body) return Buffer.alloc(0);
  const morceaux: Buffer[] = [];
  let taille = 0;
  const lecteur = r.body.getReader();
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    taille += value.byteLength;
    if (taille > RECUPERER_MAX_OCTETS) {
      await lecteur.cancel().catch(() => {});
      throw new Error("Réponse trop grande (5 Mo maximum)");
    }
    morceaux.push(Buffer.from(value));
  }
  return Buffer.concat(morceaux);
}

/**
 * Récupération brute, sans cookie ni identifiant ; chaque redirection est revérifiée avec la même règle. `arret` levé
 * (l'exécution est arrêtée) : la requête est abandonnée et la promesse rejetée avec `arret.reason`.
 */
export async function recuperer(
  brute: string,
  format: "texte" | "json",
  domaines: readonly string[] | null,
  adressesLocales: boolean,
  arret?: AbortSignal,
) {
  const delai = AbortSignal.timeout(RECUPERER_DELAI_MS);
  const echeance = arret ? AbortSignal.any([delai, arret]) : delai;
  let url = verifierUrl(brute, domaines, adressesLocales);
  try {
    for (let redirections = 0; ; redirections++) {
      const r = await fetch(url, { redirect: "manual", credentials: "omit", signal: echeance });
      const cible = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && cible) {
        await r.body?.cancel().catch(() => {});
        if (redirections >= MAX_REDIRECTIONS) throw new Error("Trop de redirections");
        url = verifierUrl(new URL(cible, url).href, domaines, adressesLocales);
        continue;
      }
      if (!r.ok) {
        await r.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${r.status}`);
      }
      const texte = (await lireCorps(r)).toString("utf8");
      if (format === "texte") return texte;
      try {
        return JSON.parse(texte) as unknown;
      } catch {
        throw new Error("La réponse n'est pas du JSON");
      }
    }
  } catch (e) {
    if (arret?.aborted) throw arret.reason;
    if (delai.aborted) throw new Error("Délai dépassé (20 s)");
    throw e;
  }
}

/** L'adresse finale de la page (après redirections) doit respecter la même règle ; sinon son texte ne sort pas. */
export function verifierPage(page: PageLue, domaines: readonly string[] | null, adressesLocales: boolean): PageLue {
  try {
    verifierUrl(String(page?.url), domaines, adressesLocales);
  } catch (e) {
    throw new Error(`Page refusée : elle a mené hors des domaines permis (${message(e)})`);
  }
  return page;
}
