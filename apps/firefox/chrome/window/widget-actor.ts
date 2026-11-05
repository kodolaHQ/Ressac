// Widget frame actor: a widget's display is served under webaios-widget: in a chrome subframe of the sidebar, in the
// parent process. Before any of its scripts, Electron's preload guard is installed in its page world; a real click in
// it records the gesture that lets that widget open one link (ui/api.ts checks it). One module for both sides, like
// page-actor.
// Kept small: the build copies this file, so any change here needs a rebuild of the app (build:ui).
import type { WebAiOsStore } from "../store";
import { contientIndiceReseau } from "../../shared/indices-reseau";

const SCHEMA = "webaios-widget:";
const STORE = "chrome://browser/content/webaios/store.sys.mjs";

/** Electron's garde-widget.ts list: TURN over TCP or UDP and ICE ignore connect-src and would leak. */
const REMOVED = [
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

const refuser = (quoi: string): never => {
  throw new TypeError(`Refusé dans l'affichage d'un widget : ${quoi}`);
};

/** A function the page can call: content calling a chrome function straight is refused, and `this` must be its own. */
function pageFunction(win: any, f: (...args: any[]) => unknown): any {
  const holder = Cu.createObjectIn(win);
  Cu.exportFunction(f, holder, { defineAs: "f" });
  return Cu.waiveXrays(holder).f;
}

/**
 * Electron's garde-widget.ts, in the page world before the widget's scripts:
 * - no WebRTC (TURN over TCP or UDP and ICE ignore connect-src and would leak);
 * - a Trusted Types "default" policy (the widget's CSP allows only it) refusing HTML that carries a network hint and
 *   any code in text (javascript: URL, attribute handler, script text: a javascript: frame has no guard and would keep
 *   WebRTC);
 * - no <link> nor <meta> built by the DOM, nor by a custom element that extends them; no XSLT (it builds elements
 *   without going through the DOM) and no setHTML (not a Trusted Types sink).
 * A nested about:blank frame has no guard, but the widget's CSP refuses frames (frame-src 'none'), and a javascript:
 * URL is refused by Trusted Types.
 */
function gardeWidget(win: any): void {
  const w = win.wrappedJSObject;
  for (const name of REMOVED) {
    try {
      delete w[name];
    } catch {
      // non-configurable property: nothing more to do
    }
  }
  for (const [proto, name] of [
    [w.Element?.prototype, "setHTML"],
    [w.ShadowRoot?.prototype, "setHTML"],
    [w.Document, "parseHTML"],
  ] as const) {
    try {
      if (proto) delete (proto as any)[name];
    } catch {
      // ditto
    }
  }
  const politique = Cu.createObjectIn(win);
  Cu.exportFunction((html: unknown) => (contientIndiceReseau(String(html)) ? refuser("<link>, <meta http-equiv> ou règles de spéculation") : String(html)), politique, { defineAs: "createHTML" });
  Cu.exportFunction(() => refuser("code en texte (URL javascript:, gestionnaire en attribut, texte d'un script)"), politique, { defineAs: "createScript" });
  Cu.exportFunction(() => refuser("script externe"), politique, { defineAs: "createScriptURL" });
  // No catch: a policy that cannot be created fails the whole guard, and no link then opens (fail closed).
  w.trustedTypes?.createPolicy("default", politique);
  const balises = ["link", "meta"];
  const nomLocal = (n: unknown) => String(n).toLowerCase().split(":").pop() ?? "";
  const D = w.Document.prototype;
  const creer = D.createElement;
  const creerNS = D.createElementNS;
  const remplacer = (proto: any, nom: string, f: (...a: any[]) => unknown) => {
    Object.defineProperty(proto, nom, { configurable: true, writable: true, value: pageFunction(win, f) });
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
  // nor <meta>, alone or inside a fragment, enters a document. The accesses are chrome's own (Xrays): the page
  // cannot divert them.
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
      if (String(nom).toLowerCase() === "inserthtml" && contientIndiceReseau(String(a[1] ?? ""))) return refuser("<link>, <meta http-equiv> ou règles de spéculation");
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
}

export class WebAiOsWidgetChild extends JSWindowActorChild {
  // DOMWindowCreated: before the widget's first script (spike P3).
  handleEvent() {
    const doc = this.document;
    // No `matches` catches the scheme (spike P3): the child filters on the document's URL itself.
    if (!doc.documentURI.startsWith(SCHEMA)) return;
    const win = this.contentWindow as any;
    if (!win) return;
    // Fail closed: a guard that did not install records no gesture, so ui/api.ts refuses every link. The CSP alone
    // would not stop a dynamic <link>/<meta> nor WebRTC, so a half-installed guard must not let links out either.
    try {
      gardeWidget(win);
    } catch (e) {
      console.error("[widget] guard not installed, links stay closed:", e);
      return;
    }
    // Capture phase: the widget's own handlers may stop the event later. isTrusted keeps synthetic clicks out, and
    // the page cannot forge the flag.
    win.addEventListener(
      "pointerdown",
      (event: any) => {
        if (!event.isTrusted) return;
        (this as unknown as { sendAsyncMessage(name: string, data?: unknown): void }).sendAsyncMessage("geste", { widget: new URL(doc.documentURI).hostname });
      },
      true,
    );
  }
}

export class WebAiOsWidgetParent extends JSWindowActorParent {
  async receiveMessage(m: { name: string; data?: { widget?: unknown } }) {
    if (m.name !== "geste") return;
    const uri: { spec?: string } | undefined = (this.manager as any).documentURI;
    if (!uri?.spec?.startsWith(SCHEMA)) return;
    // The widget is the document's own host, read here: the page cannot name another widget.
    const widget = new URL(uri.spec).hostname;
    if (m.data?.widget !== widget) return;
    // The store is a shared module: imported at runtime, never bundled here (that would make a second copy).
    const win = (this as unknown as { browsingContext: { topChromeWindow?: any } }).browsingContext?.topChromeWindow;
    const fenetreId = win?.webaiosWindow?.fenetreId;
    if (typeof fenetreId !== "string") return console.warn("[widget] gesture ignored, no WebAiOs window:", widget);
    const { gestesWidgets } = (await ChromeUtils.importESModule(STORE).ready) as WebAiOsStore;
    gestesWidgets.geste(fenetreId, widget);
  }
}
