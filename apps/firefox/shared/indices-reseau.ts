/**
 * Ce qui, dans le HTML d'un affichage de widget, ferait sortir quelque chose de la machine sans passer par la CSP :
 * `<link>` (dns-prefetch résout un nom choisi par le widget : les données partent dans la requête DNS), `<meta
 * http-equiv>` (x-dns-prefetch-control: on rallumerait la résolution des liens) et les règles de spéculation. Refusé
 * dans affichage.html (servi depuis une copie, widget-frame.ts) comme dans le HTML que l'affichage écrit (garde du
 * cadre, widget-actor.ts). Copie de apps/navigateur/src/commun/indices-reseau.ts.
 *
 * Sans import : le bundle actor ne doit pas tirer les helpers chrome de la sidebar (widget-frame.ts).
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
    x = x.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos));?/gi, (_m, dec?: string, hex?: string, nom?: string) => {
      if (nom) return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[nom.toLowerCase()]!;
      const n = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : String.fromCharCode(0xfffd);
    });
  } while (x !== avant);
  return new RegExp(MOTIF_INDICES_RESEAU, "i").test(x);
}
