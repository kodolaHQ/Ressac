import { ID_SITE } from "@webaios/noyau";
import { SCHEMA_SITE } from "../../commun/sites";

/**
 * L'appli dont `url` est une page de l'accueil (`webaios-site://<id>/<…>.html`, paramètres permis), sinon null : un cadre
 * d'accueil ne charge que des pages (jamais une image ou un script en document).
 */
export function accueilSiteDuCadre(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEMA_SITE}:` || u.port || u.username || u.password || !ID_SITE.test(u.hostname)) return null;
  return /^\/[^?#]*\.html$/.test(u.pathname) ? u.hostname : null;
}
