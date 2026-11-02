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

type CadreGeste = { url: string; frameTreeNodeId: number; parent: { frameTreeNodeId: number } | null };

/**
 * L'appli d'un geste reçu de l'accueil (canal `siteAccueilGeste`), ou null : le cadre doit être posé directement dans la
 * page de la fenêtre de l'appli `id` (jamais cette page elle-même, ni un cadre imbriqué) et montrer son propre accueil
 * (jamais celui d'une autre appli). `id` : l'appli de la fenêtre qui envoie, undefined si ce n'en est pas une.
 */
export function gesteAccueilDuCadre(cadre: CadreGeste | null, principal: { frameTreeNodeId: number }, id: string | undefined): string | null {
  if (!cadre || !id) return null;
  if (cadre.frameTreeNodeId === principal.frameTreeNodeId || cadre.parent?.frameTreeNodeId !== principal.frameTreeNodeId) return null;
  return accueilSiteDuCadre(cadre.url) === id ? id : null;
}
