import type { Session } from "electron";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { adresseLocale, hoteDansSite, ID_SITE, type CheminsEspace } from "@webaios/noyau";
import { IMAGE_SITE_MAX, SCHEMA_SITE } from "../../commun/sites";
import { contientIndiceReseau } from "../../commun/indices-reseau";
import { AFFICHAGE_REFUSE, CSP_WIDGET } from "../agent/accueil";
import { corpsBorne } from "../reseau-interface";

/** Taille maximale d'un fichier de l'accueil (page, script, style, image). */
export const FICHIER_ACCUEIL_MAX = 2 * 1024 * 1024;
/** Redirections suivies pour une image du site, chacune revérifiée. */
const REDIRECTIONS_IMAGE = 3;
const DELAI_IMAGE_MS = 10_000;

/** Les directives de `CSP_WIDGET` où les fichiers de l'appli sont permis. */
const DIRECTIVES_FICHIERS = new Set(["script-src", "style-src", "img-src", "font-src"]);

/**
 * La CSP de l'accueil de l'appli `id` : celle d'un affichage de widget (aucun réseau, aucun cadre, aucun formulaire), où
 * scripts, styles, images et polices peuvent aussi venir des fichiers de cette appli (`webaios-site://<id>`), jamais d'une autre.
 */
export function cspAccueilSite(id: string): string {
  return CSP_WIDGET.split("; ")
    .map((d) => (DIRECTIVES_FICHIERS.has(d.split(" ")[0]!) ? `${d} ${SCHEMA_SITE}://${id}` : d))
    .join("; ");
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/** L'id et les segments du chemin sous `accueil/` d'une URL `webaios-site:`, sinon null (aucun segment vide, caché, `..`, ni séparateur encodé). */
function cible(url: string): { id: string; segments: string[] } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEMA_SITE}:` || u.port || u.username || u.password || !ID_SITE.test(u.hostname)) return null;
  const segments: string[] = [];
  for (const brut of u.pathname.slice(1).split("/")) {
    let s: string;
    try {
      s = decodeURIComponent(brut);
    } catch {
      return null;
    }
    if (!s || s.startsWith(".") || /[\\/\0]/.test(s)) return null;
    segments.push(s);
  }
  return segments.length ? { id: u.hostname, segments } : null;
}

const introuvable = () => new Response("", { status: 404 });

/**
 * Réponse du schéma `webaios-site:` : seulement un fichier de `<sites>/<id>/accueil/`, le dossier de l'appli nommé
 * exactement `id` (un disque insensible à la casse trouverait « MonSite » pour « monsite »), aucun lien symbolique sur le
 * chemin (ni le dossier des applis, ni l'appli, ni l'accueil, ni le fichier), `FICHIER_ACCUEIL_MAX` au plus. Une page qui
 * contient un indice réseau est remplacée par `AFFICHAGE_REFUSE` (le parseur la traiterait avant la garde du preload).
 * Tout est servi avec la CSP de l'accueil de cette appli. 404 sinon.
 */
export async function repondreAccueilSite(chemins: Pick<CheminsEspace, "sites">, url: string): Promise<Response> {
  const c = cible(url);
  if (!c) return introuvable();
  try {
    if ((await lstat(chemins.sites)).isSymbolicLink()) return introuvable();
    if (!(await readdir(chemins.sites)).includes(c.id)) return introuvable();
    const attendu = join(await realpath(chemins.sites), c.id, "accueil", ...c.segments);
    // realpath résout tout lien du chemin : s'il diffère du chemin attendu, un lien (ou une autre casse) s'y trouve.
    const reel = await realpath(join(chemins.sites, c.id, "accueil", ...c.segments));
    if (reel !== attendu) return introuvable();
    const infos = await stat(reel);
    if (!infos.isFile() || infos.size > FICHIER_ACCUEIL_MAX) return introuvable();
    const type = TYPES[extname(reel).toLowerCase()] ?? "application/octet-stream";
    const contenu = await readFile(reel);
    const corps = type.startsWith("text/html") && contientIndiceReseau(contenu.toString("utf8")) ? AFFICHAGE_REFUSE : contenu;
    return new Response(corps, {
      headers: {
        "Content-Type": type,
        "Content-Security-Policy": cspAccueilSite(c.id),
        // La résolution des liens reste coupée, même si la page essaie de la rallumer.
        "X-DNS-Prefetch-Control": "off",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return introuvable();
  }
}

/**
 * Adresse https sans identifiants, sur un domaine de l'appli ; http seulement vers un hôte local (les domaines d'une
 * appli ne le sont qu'en test) : les cookies de l'appli ne partent jamais en clair.
 */
function imagePermise(url: string, domaines: readonly string[]): boolean {
  try {
    const u = new URL(url);
    const schema = u.protocol === "https:" || (u.protocol === "http:" && adresseLocale(u.hostname));
    return schema && !u.username && !u.password && hoteDansSite(u.hostname, domaines);
  } catch {
    return false;
  }
}

/** Un type d'image simple (`image/png`), jamais recopié tel quel s'il contient autre chose. */
const TYPE_IMAGE = /^image\/[a-z0-9.+-]+$/;

/**
 * Une image du site demandée par l'accueil, rendue en `data:` : seulement en https sur un domaine de l'appli (chaque redirection
 * revérifiée, `REDIRECTIONS_IMAGE` au plus), chargée avec la session de l'appli (ses cookies), `image/*`,
 * `IMAGE_SITE_MAX` au plus. null sinon.
 */
export async function imageSite(s: Pick<Session, "fetch">, url: string, domaines: readonly string[]): Promise<string | null> {
  if (!imagePermise(url, domaines)) return null;
  const arret = new AbortController();
  const minuterie = setTimeout(() => arret.abort(), DELAI_IMAGE_MS);
  try {
    let adresse = url;
    let r = await s.fetch(adresse, { signal: arret.signal, credentials: "include", redirect: "manual" });
    for (let sauts = 0; r.status >= 300 && r.status < 400; sauts++) {
      await r.body?.cancel().catch(() => {});
      const location = r.headers.get("location");
      if (!location || sauts >= REDIRECTIONS_IMAGE) return null;
      const suivante = new URL(location, adresse).href;
      if (!imagePermise(suivante, domaines)) return null;
      adresse = suivante;
      r = await s.fetch(adresse, { signal: arret.signal, credentials: "include", redirect: "manual" });
    }
    const type = r.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!r.ok || !TYPE_IMAGE.test(type) || Number(r.headers.get("content-length") ?? 0) > IMAGE_SITE_MAX) {
      await r.body?.cancel().catch(() => {});
      return null;
    }
    const corps = await corpsBorne(r, IMAGE_SITE_MAX);
    return corps ? `data:${type};base64,${corps.toString("base64")}` : null;
  } catch {
    return null;
  } finally {
    clearTimeout(minuterie);
  }
}
