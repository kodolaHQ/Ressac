import { MOTIF_INDICES_RESEAU, contientIndiceReseau } from "../../shared/indices-reseau";

/**
 * Electron's CSP (main/agent/accueil.ts), copied: a resource:// file cannot carry a response header, so the CSP is
 * injected as a `<meta http-equiv>` into the copy the sidebar writes.
 */
export const CSP_WIDGET =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types default";
/** Servi à la place d'un affichage qui contient un indice réseau (copie d'indices-reseau.ts, Electron). */
export const AFFICHAGE_REFUSE =
  '<!doctype html><meta charset="utf-8"><p style="font: 13px system-ui; color: #b44">Affichage refusé : il contient &lt;link&gt;, &lt;meta http-equiv&gt; ou des règles de spéculation, qui feraient sortir des données. Voir AGENTS.md.</p>';

const ID_WIDGET = /^[a-z0-9-]+$/;
const PREFIXE = "webaios-widget-";

/** Le nom de la substitution resource:// d'un widget : `webaios-widget-<id>`. */
function nomSubstitution(id: string): string {
  return `${PREFIXE}${id}`;
}

/** L'URL du cadre : la copie assainie, datée du mtime de la source (un nouveau mtime recharge le cadre). */
export function urlAffichage(id: string, mtime: number): string {
  return `resource://${PREFIXE}${id}/affichage-${mtime}.html`;
}

/** Le dossier des copies d'un widget : `<dataDir>/webaios-widgets/<id>/`. */
function dossierCopies(dataDir: string, id: string): string {
  return PathUtils.join(dataDir, "webaios-widgets", id);
}

/**
 * Le dossier des copies, créé puis confiné à `<dataDir>/webaios-widgets` : un dossier de copies qui est un lien
 * symbolique est refusé. Rend son vrai chemin, où les copies sont écrites.
 */
async function dossierCopiesConfine(dataDir: string, id: string): Promise<string | null> {
  const dossier = dossierCopies(dataDir, id);
  await IOUtils.makeDirectory(dossier, { createAncestors: true, ignoreExisting: true });
  const racine = cheminReel(PathUtils.join(dataDir, "webaios-widgets"));
  const reel = cheminReel(dossier);
  return racine && reel && reel.startsWith(racine + "/") ? reel : null;
}

/** La copie assainie d'un affichage : `<dossierCopies>/affichage-<mtime>.html`. */
export function cheminCopie(dataDir: string, id: string, mtime: number): string {
  return PathUtils.join(dossierCopies(dataDir, id), `affichage-${mtime}.html`);
}

/**
 * `realpath`, en synchrone (`nsIFile.normalize`). L'agent écrit dans les dossiers des widgets : un lien symbolique ne
 * doit pas y montrer un fichier du Mac.
 */
function cheminReel(chemin: string): string | null {
  try {
    const fichier = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    fichier.initWithPath(chemin);
    fichier.normalize();
    return fichier.path;
  } catch {
    return null;
  }
}

/** Le vrai chemin de `<dataDir>/espace/accueil/widgets/<id>/affichage.html`, confiné au dossier du widget. */
function cheminSource(dataDir: string, id: string): string | null {
  if (!ID_WIDGET.test(id)) return null;
  const widgetsDir = PathUtils.join(dataDir, "espace", "accueil", "widgets");
  const dossier = PathUtils.join(widgetsDir, id);
  const racine = cheminReel(widgetsDir);
  const reelDossier = cheminReel(dossier);
  const reelFichier = cheminReel(PathUtils.join(dossier, "affichage.html"));
  if (!racine || !reelDossier || !reelFichier) return null;
  return reelDossier.startsWith(racine + "/") && reelFichier.startsWith(reelDossier + "/") ? reelFichier : null;
}

/**
 * Electron's `garde-widget.ts`, run in the page world from the served copy before the widget's own scripts. No
 * `JSWindowActor`: measured, the actor's child never installs on these `resource://` frames in this Firefox. Self-contained
 * (no imports, no `win`: it uses the page's `window`), serialized with `toString()`, the network-hint pattern passed as
 * its argument. The WebRTC globals go last: if an earlier step throws, `RTCPeerConnection` is still there, and the UI
 * (which only attaches its gesture listener when it is gone) records no click — the guard fails closed.
 */
function gardeWidget(motif: string): void {
  const w = window as unknown as Record<string, any>;
  const refuser = (quoi: string): never => {
    throw new TypeError(`Refusé dans l'affichage d'un widget : ${quoi}`);
  };
  const indice = new RegExp(motif, "i");
  const contientIndice = (html: string) => {
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
    return indice.test(x);
  };
  // No catch: a policy that cannot be created fails the whole guard, and no link then opens.
  w.trustedTypes?.createPolicy("default", {
    createHTML: (html: string) => (contientIndice(String(html)) ? refuser("<link>, <meta http-equiv> ou règles de spéculation") : html),
    createScript: () => refuser("code en texte (URL javascript:, gestionnaire en attribut, texte d'un script)"),
    createScriptURL: () => refuser("script externe"),
  });
  const balises = ["link", "meta"];
  const nomLocal = (n: unknown) => String(n).toLowerCase().split(":").pop() ?? "";
  const D = w.Document.prototype;
  const creer = D.createElement;
  const creerNS = D.createElementNS;
  const remplacer = (proto: any, nom: string, f: (...a: any[]) => unknown) => {
    Object.defineProperty(proto, nom, { configurable: true, writable: true, value: f });
  };
  remplacer(D, "createElement", function (this: unknown, nom: unknown, o?: unknown) {
    if (balises.includes(nomLocal(nom))) return refuser(`<${String(nom)}>`);
    return creer.call(this, nom, o);
  });
  remplacer(D, "createElementNS", function (this: unknown, ns: unknown, nom: unknown, o?: unknown) {
    if (balises.includes(nomLocal(nom))) return refuser(`<${String(nom)}>`);
    return creerNS.call(this, ns, nom, o);
  });
  // Structural rule, whatever the path (createDocument then adoptNode, DOMParser, template, cloneNode…): no <link>
  // nor <meta>, alone or inside a fragment, enters a document. The accessors are taken now, before the widget.
  const selecteur = balises.join(",");
  const interditDans = (n: any): boolean => {
    if (!n || typeof n !== "object") return false;
    let t: number;
    try {
      t = n.nodeType;
    } catch {
      return false; // not a node (text given to append): nothing to check
    }
    if (t === 1) return balises.includes(String(n.localName).toLowerCase()) || n.querySelector(selecteur) !== null;
    if (t === 11) return n.querySelector(selecteur) !== null;
    return false;
  };
  const garder = (proto: any, noms: string[]) => {
    if (!proto) return;
    for (const nom of noms) {
      const f = proto[nom];
      if (typeof f !== "function") continue;
      remplacer(proto, nom, function (this: unknown, ...a: unknown[]) {
        if (a.some(interditDans)) return refuser("<link> ou <meta> inséré dans la page");
        return f.apply(this, a);
      });
    }
  };
  garder(w.Node.prototype, ["appendChild", "insertBefore", "replaceChild"]);
  const enfants = ["append", "prepend", "replaceChildren"];
  const voisins = ["before", "after", "replaceWith"];
  garder(w.Element.prototype, [...enfants, ...voisins, "insertAdjacentElement"]);
  garder(D, enfants);
  garder(w.DocumentFragment.prototype, enfants);
  garder(w.CharacterData?.prototype, voisins);
  garder(w.DocumentType?.prototype, voisins);
  garder(w.Range?.prototype, ["insertNode", "surroundContents"]);
  // execCommand("insertHTML") is not a Trusted Types sink.
  const commande = D.execCommand;
  if (typeof commande === "function")
    remplacer(D, "execCommand", function (this: unknown, nom: unknown, ...a: unknown[]) {
      if (String(nom).toLowerCase() === "inserthtml" && contientIndice(String(a[1] ?? ""))) return refuser("<link>, <meta http-equiv> ou règles de spéculation");
      return commande.call(this, nom, ...a);
    });
  const R = w.CustomElementRegistry?.prototype;
  if (R) {
    const definir = R.define;
    remplacer(R, "define", function (this: unknown, nom: unknown, classe: unknown, o?: { extends?: unknown }) {
      if (o && balises.includes(nomLocal(o.extends))) return refuser(`élément qui étend <${String(o.extends)}>`);
      return definir.call(this, nom, classe, o);
    });
  }
  // Last: see the comment on gardeWidget.
  const absents = [
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "RTCDataChannel",
    "RTCSessionDescription",
    "RTCIceCandidate",
    "RTCRtpSender",
    "RTCRtpReceiver",
    "RTCRtpTransceiver",
    "RTCDtlsTransport",
    "RTCIceTransport",
    "RTCSctpTransport",
    "RTCCertificate",
    "RTCDTMFSender",
    "RTCEncodedAudioFrame",
    "RTCEncodedVideoFrame",
    "RTCRtpScriptTransform",
    "RTCPeerConnectionIceEvent",
    "RTCDataChannelEvent",
    "RTCTrackEvent",
    "XSLTProcessor",
  ];
  for (const nom of absents) {
    try {
      delete w[nom];
    } catch {
      // non-configurable property: nothing more to do
    }
  }
  for (const [proto, nom] of [
    [w.Element?.prototype, "setHTML"],
    [w.ShadowRoot?.prototype, "setHTML"],
    [w.Document, "parseHTML"],
  ] as const) {
    try {
      if (proto) delete (proto as any)[nom];
    } catch {
      // ditto
    }
  }
}

/** The guard's `<script>`, injected into the served copy after the CSP meta: the page parser runs it first. */
const SCRIPT_GARDE = `<script>(${gardeWidget.toString()})(${JSON.stringify(MOTIF_INDICES_RESEAU)});</script>`;

/** Whitespace, leading comments and an optional doctype: everything the guard must be inserted after. */
const PREFIXE_DOC = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype[^>]*>\s*)?/i;

/**
 * Le texte servi : la meta CSP puis la garde, après un éventuel doctype (le doctype reste le premier jeton, pas de
 * mode quirks) et avant tout autre élément ; AFFICHAGE_REFUSE si le HTML contient un indice réseau.
 */
export function affichageServi(html: string): string {
  if (contientIndiceReseau(html)) return AFFICHAGE_REFUSE;
  const prefixe = html.match(PREFIXE_DOC)?.[0] ?? "";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}">`;
  return `${prefixe}${meta}${SCRIPT_GARDE}${html.slice(prefixe.length)}`;
}

/** La substitution resource:// du widget, ou `null` pour la retirer. */
function substituer(id: string, dossier: string | null): void {
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler)
    .setSubstitution(nomSubstitution(id), dossier ? Services.io.newFileURI(new FileUtils.File(dossier)) : null);
}

/**
 * Prépare l'affichage d'un widget : écrit sa copie assainie si le mtime de la source a changé, puis pose la
 * substitution `resource://webaios-widget-<id>/`. Rend l'URL du cadre, ou null si l'affichage est absent ou sort de son
 * dossier.
 */
export async function preparerWidget(dataDir: string, id: string): Promise<string | null> {
  const source = cheminSource(dataDir, id);
  if (!source) return null;
  let mtime: number;
  try {
    mtime = Math.round((await IOUtils.stat(source)).lastModified);
  } catch {
    return null;
  }
  const dossier = dossierCopies(dataDir, id);
  try {
    const reel = await dossierCopiesConfine(dataDir, id);
    if (!reel) {
      console.warn(`[widget] dossier de copies de ${id} hors de <dataDir>/webaios-widgets : refusé`);
      return null;
    }
    const copie = PathUtils.join(reel, `affichage-${mtime}.html`);
    // Même mtime : la copie existe déjà, on ne la réécrit pas (l'URL ne change pas).
    if (!(await IOUtils.exists(copie))) {
      // shortcut: the source is read by the realpath computed just before; a symlink swapped in by another process
      // between the check and the read is still followed (IOUtils has no O_NOFOLLOW). Upgrade if the widgets folder can
      // be written by an untrusted process.
      // Écriture atomique (motif de site-permissions.ts) : un cadre ne lit jamais une copie à moitié écrite.
      const temporaire = `${copie}.${crypto.randomUUID()}.tmp`;
      await IOUtils.writeUTF8(temporaire, affichageServi(await IOUtils.readUTF8(source)), { flush: true });
      await IOUtils.move(temporaire, copie);
      // Une seule copie par widget : la précédente est retirée.
      for (const ancien of await IOUtils.getChildren(reel)) {
        if (ancien !== copie && /affichage-.*\.html$/.test(ancien)) await IOUtils.remove(ancien, { ignoreAbsent: true });
      }
    }
    substituer(id, dossier);
  } catch (e) {
    console.error(`[widget] copie de ${id} impossible :`, e);
    return null;
  }
  return urlAffichage(id, mtime);
}

/** Le widget n'existe plus : retire sa substitution et son dossier de copies (au mieux). */
export async function oublierWidget(dataDir: string, id: string): Promise<void> {
  if (!ID_WIDGET.test(id)) return;
  try {
    substituer(id, null);
  } catch {
    // rien à retirer
  }
  await IOUtils.remove(dossierCopies(dataDir, id), { recursive: true, ignoreAbsent: true }).catch(() => {});
}
