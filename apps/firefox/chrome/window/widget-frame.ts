import { realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Electron's scheme and CSP (main/agent/accueil.ts), copied: Firefox has no way to set a response header for a custom
 * channel (`nsIHttpChannel` is `[builtinclass]`), so the CSP is injected as a `<meta http-equiv>` into the served HTML.
 */
export const SCHEMA_WIDGET = "webaios-widget";
export const CSP_WIDGET =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types default";
/** Servi à la place d'un affichage qui contient un indice réseau (copie d'indices-reseau.ts, Electron). */
export const AFFICHAGE_REFUSE =
  '<!doctype html><meta charset="utf-8"><p style="font: 13px system-ui; color: #b44">Affichage refusé : il contient &lt;link&gt;, &lt;meta http-equiv&gt; ou des règles de spéculation, qui feraient sortir des données. Voir AGENTS.md.</p>';

const ID_WIDGET = /^[a-z0-9-]+$/;
/**
 * Ce qui, dans le HTML d'un affichage, ferait sortir quelque chose sans passer par la CSP : `<link>` (dns-prefetch),
 * `<meta http-equiv>` et les règles de spéculation. Copie de apps/navigateur/src/commun/indices-reseau.ts.
 */
const MOTIF_INDICES_RESEAU = "<\\s*link(?![a-z0-9-])|http-equiv|speculationrules";

/** Décode ce qui peut cacher un `<` dans un attribut (`srcdoc="&lt;link …"`, imbriqué : `&amp;lt;`) avant de chercher. */
function contientIndiceReseau(html: string): boolean {
  let avant: string;
  let x = html;
  do {
    avant = x;
    x = x.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos));?/gi, (_m, dec?: string, hex?: string, nom?: string) => {
      if (nom) return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[nom.toLowerCase()]!;
      const n = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�";
    });
  } while (x !== avant);
  return new RegExp(MOTIF_INDICES_RESEAU, "i").test(x);
}

/**
 * `realpath`, en synchrone. Dans Firefox le store est un bundle où `node:fs` est un shim (le host n'a pas Node) :
 * `nsIFile.normalize()` fait le même `realpath`. En test unitaire, `Ci` n'existe pas et c'est le vrai `node:fs`.
 */
function cheminReel(chemin: string): string | null {
  try {
    if (typeof Ci === "undefined") return realpathSync(chemin);
    const fichier = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    fichier.initWithPath(chemin);
    fichier.normalize();
    return fichier.path;
  } catch {
    return null;
  }
}

/**
 * Le fichier d'un affichage (`webaios-widget://<id>/affichage.html[?v=…]`), jamais un autre : id en minuscules, chemin
 * exact, et le `realpath` du dossier du widget et du fichier restent dans le dossier des widgets (l'agent écrit dans ces
 * dossiers : un lien symbolique ne doit pas y montrer un fichier du Mac).
 */
export function fichierAffichage(url: string, widgetsDir: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEMA_WIDGET}:` || !ID_WIDGET.test(u.hostname) || u.pathname !== "/affichage.html") return null;
  // `new URL` normalise déjà `..` : on compare l'autorité et le chemin bruts, ce qui refuse aussi un port, un hôte
  // majuscule et les séparateurs encodés (`%2F`, `%5C`, `%2e%2e`).
  const apresSchema = url.slice(url.indexOf("://") + 3);
  const fin = apresSchema.search(/[?#]/);
  if ((fin < 0 ? apresSchema : apresSchema.slice(0, fin)) !== `${u.hostname}/affichage.html`) return null;
  const dossier = join(widgetsDir, u.hostname);
  const racine = cheminReel(widgetsDir);
  const reelDossier = cheminReel(dossier);
  const reelFichier = cheminReel(join(dossier, "affichage.html"));
  if (!racine || !reelDossier || !reelFichier) return null;
  return reelDossier.startsWith(racine + "/") && reelFichier.startsWith(reelDossier + "/") ? reelFichier : null;
}

/** Le texte servi : la meta CSP d'abord (avant tout script) ; AFFICHAGE_REFUSE si le HTML contient un indice réseau. */
export function affichageServi(html: string): string {
  if (contientIndiceReseau(html)) return AFFICHAGE_REFUSE;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}">`;
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  return doctype ? `${doctype[0]}${meta}${html.slice(doctype[0].length)}` : meta + html;
}

/** Le texte d'un fichier en synchrone (`newChannel` doit rendre son canal tout de suite) ; null s'il est illisible. */
function lireFichier(chemin: string): string | null {
  try {
    // shortcut: the file is opened by the realpath computed just before; a symlink swapped in by another process
    // between the check and the open is still followed (these APIs have no O_NOFOLLOW). Upgrade if the widgets folder
    // can be written by an untrusted process.
    const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    const fichier = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    fichier.initWithPath(chemin);
    const flux = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    flux.init(fichier, -1, 0, 0);
    try {
      const octets = flux.available();
      return octets === 0 ? "" : NetUtil.readInputStreamToString(flux, octets, { charset: "UTF-8" });
    } finally {
      flux.close();
    }
  } catch {
    return null;
  }
}

let enregistre = false;

/**
 * Sert les affichages des widgets au processus parent seulement (un schéma posé à l'exécution n'existe pas dans les
 * processus de contenu) : appelé une fois, au démarrage du store.
 */
export function registerWidgetProtocol(o: { widgetsDir: string }): void {
  if (enregistre) return;
  enregistre = true;
  const handler = {
    scheme: SCHEMA_WIDGET,
    allowPort: () => false,
    newChannel(uri: any, loadInfo: any) {
      const chemin = fichierAffichage(uri.spec, o.widgetsDir);
      const html = chemin ? lireFichier(chemin) : null;
      if (html === null) throw (Components as any).Exception(`webaios-widget: nothing at ${uri.spec}`, Cr.NS_ERROR_FILE_NOT_FOUND);
      const flux = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
      flux.setUTF8Data(affichageServi(html));
      const canal = Cc["@mozilla.org/network/input-stream-channel;1"].createInstance(Ci.nsIInputStreamChannel).QueryInterface(Ci.nsIChannel);
      canal.setURI(uri);
      if (loadInfo) canal.loadInfo = loadInfo;
      canal.contentType = "text/html";
      canal.contentCharset = "utf-8";
      canal.contentStream = flux;
      // Pas d'en-tête possible : `LOAD_BYPASS_CACHE` est le « Cache-Control: no-store » du canal (`?v=<mtime>` recharge).
      canal.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE;
      return canal;
    },
    QueryInterface: ChromeUtils.generateQI(["nsIProtocolHandler"]),
  };
  Services.io.registerProtocolHandler(
    SCHEMA_WIDGET,
    handler,
    Ci.nsIProtocolHandler.URI_STD | Ci.nsIProtocolHandler.URI_IS_POTENTIALLY_TRUSTWORTHY | Ci.nsIProtocolHandler.URI_DANGEROUS_TO_LOAD | Ci.nsIProtocolHandler.URI_NON_PERSISTABLE,
    -1,
  );
}
