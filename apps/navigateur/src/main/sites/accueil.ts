import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, join } from "node:path";
import { adresseLocale, hoteDansSite, ID_SITE, type CheminsEspace } from "@webaios/noyau";
import { IMAGE_SITE_MAX, SCHEMA_SITE } from "../../commun/sites";
import { contientIndiceReseau } from "../../commun/indices-reseau";
import { AFFICHAGE_REFUSE, CSP_WIDGET } from "../agent/accueil";
import { chargerImage, type OuvrirRequete } from "../image-distante";

/** Taille maximale d'un fichier de l'accueil (page, script, style, image). */
export const FICHIER_ACCUEIL_MAX = 2 * 1024 * 1024;

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
 * Le contenu du fichier `chemin`, lu par son descripteur : ouvert sans suivre un lien (`O_NOFOLLOW` : un fichier devenu
 * lien après la vérification des chemins est refusé) ni attendre (`O_NONBLOCK` : un tube nommé ne bloque pas la lecture),
 * puis `fstat` (un fichier ordinaire, `FICHIER_ACCUEIL_MAX` au plus) et une lecture bornée. null sinon.
 */
async function lireSansLien(chemin: string): Promise<Buffer | null> {
  const f = await open(chemin, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!f) return null;
  try {
    const infos = await f.stat();
    if (!infos.isFile() || infos.size > FICHIER_ACCUEIL_MAX) return null;
    // Un octet de plus que la taille vue : un fichier qui grandit pendant la lecture est refusé, jamais tronqué.
    const tampon = Buffer.alloc(infos.size + 1);
    let lus = 0;
    for (;;) {
      const { bytesRead } = await f.read(tampon, lus, tampon.length - lus, lus);
      if (bytesRead === 0) break;
      lus += bytesRead;
      if (lus > infos.size) return null;
    }
    return tampon.subarray(0, lus);
  } finally {
    await f.close().catch(() => {});
  }
}

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
    const contenu = await lireSansLien(attendu);
    if (!contenu) return introuvable();
    const type = TYPES[extname(attendu).toLowerCase()] ?? "application/octet-stream";
    const corps = type.startsWith("text/html") && contientIndiceReseau(contenu.toString("utf8")) ? AFFICHAGE_REFUSE : new Uint8Array(contenu);
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

/**
 * Une image du site demandée par l'accueil, rendue en `data:` : seulement en https sur un domaine de l'appli (chaque
 * redirection revérifiée avant d'être suivie, `REDIRECTIONS_IMAGE` au plus), chargée par les requêtes de la session de
 * l'appli (`ouvrir`, ses cookies), `image/*`, `IMAGE_SITE_MAX` au plus. null sinon.
 */
export async function imageSite(ouvrir: OuvrirRequete, url: string, domaines: readonly string[]): Promise<string | null> {
  const image = await chargerImage(ouvrir, url, { permise: (u) => imagePermise(u, domaines), cookies: true, max: IMAGE_SITE_MAX });
  return image ? `data:${image.type};base64,${image.corps.toString("base64")}` : null;
}
