/**
 * Ce qui, dans le HTML d'un affichage de widget, ferait sortir quelque chose de la machine sans passer par la CSP :
 * `<link>` (dns-prefetch résout un nom choisi par le widget : les données partent dans la requête DNS), `<meta
 * http-equiv>` (x-dns-prefetch-control: on rallumerait la résolution des liens) et les règles de spéculation. Refusé
 * dans affichage.html (servi par le navigateur) comme dans le HTML que l'affichage écrit (preload, garde-widget.ts).
 */
export const MOTIF_INDICES_RESEAU = "<\\s*link(?![a-z0-9-])|http-equiv|speculationrules";

/**
 * Décode ce qui peut cacher un `<` dans un attribut (`srcdoc="&lt;link …"`, y compris imbriqué : `&amp;lt;`) avant de
 * chercher le motif. Un faux positif (le mot dans un texte) refuse seulement l'affichage : l'agent le réécrit.
 */
export function contientIndiceReseau(html: string): boolean {
  let avant: string;
  let x = html;
  do {
    avant = x;
    x = x.replace(/&(amp|lt|#0*60|#x0*3c);?/gi, (_m, e: string) => (e.toLowerCase() === "amp" ? "&" : "<"));
  } while (x !== avant);
  return new RegExp(MOTIF_INDICES_RESEAU, "i").test(x);
}
