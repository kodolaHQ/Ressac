/**
 * Exécuté dans le monde de la page de chaque cadre de l'interface (affichage d'un widget, ou cadre imbriqué dedans),
 * avant ses scripts (contextBridge.executeInMainWorld). Sérialisé : la fonction ne doit rien utiliser de l'extérieur,
 * tout arrive par `motif` (MOTIF_INDICES_RESEAU).
 *
 * - Plus de WebRTC : TURN en TCP ou UDP, ICE, ignorent la CSP (connect-src) et sortiraient des données.
 * - Trusted Types (la CSP du widget les exige, `trusted-types default`) : la politique « default », créée ici avant le
 *   widget qui ne peut en créer aucune autre, refuse le HTML qui contient un indice réseau (voir indices-reseau.ts), et
 *   tout code en texte (URL javascript:, gestionnaire en attribut, texte d'un <script>) : un cadre javascript: n'a pas
 *   ce preload, donc il aurait encore WebRTC.
 * - Pas de <link> ni de <meta> créés par le DOM, ni d'élément personnalisé qui les étend ; pas de XSLT (qui fabrique
 *   des éléments sans passer par là) ni de setHTML (qui n'est pas un point Trusted Types).
 *
 * Un cadre about:blank imbriqué n'a pas ce preload, mais le widget (origine opaque) ne peut ni y lire ni y écrire, et
 * une URL javascript: y est refusée par Trusted Types : aucun code n'y tourne.
 */
export function gardeWidget(motif: string): void {
  const w = window as unknown as Record<string, any>;
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
      // propriété non configurable : rien de plus à faire
    }
  }
  for (const [proto, nom] of [
    [w.Element?.prototype, "setHTML"],
    [w.ShadowRoot?.prototype, "setHTML"],
    [w.Document, "parseHTML"],
  ] as const) {
    try {
      if (proto) delete proto[nom];
    } catch {
      // idem
    }
  }
  const refuser = (quoi: string): never => {
    throw new TypeError(`Refusé dans l'affichage d'un widget : ${quoi}`);
  };
  const indice = new RegExp(motif, "i");
  const contientIndice = (html: string) => {
    let avant: string;
    let x = html;
    do {
      avant = x;
      x = x.replace(/&(amp|lt|#0*60|#x0*3c);?/gi, (_m, e: string) => (e.toLowerCase() === "amp" ? "&" : "<"));
    } while (x !== avant);
    return indice.test(x);
  };
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
  Object.defineProperty(D, "createElement", {
    configurable: true,
    writable: true,
    value: function createElement(this: unknown, nom: unknown, o?: unknown) {
      if (balises.includes(nomLocal(nom))) refuser(`<${String(nom)}>`);
      return creer.call(this, nom, o);
    },
  });
  Object.defineProperty(D, "createElementNS", {
    configurable: true,
    writable: true,
    value: function createElementNS(this: unknown, ns: unknown, nom: unknown, o?: unknown) {
      if (balises.includes(nomLocal(nom))) refuser(`<${String(nom)}>`);
      return creerNS.call(this, ns, nom, o);
    },
  });
  const R = w.CustomElementRegistry?.prototype;
  if (R) {
    const definir = R.define;
    Object.defineProperty(R, "define", {
      configurable: true,
      writable: true,
      value: function define(this: unknown, nom: unknown, classe: unknown, o?: { extends?: unknown }) {
        if (o && balises.includes(nomLocal(o.extends))) refuser(`élément qui étend <${String(o.extends)}>`);
        return definir.call(this, nom, classe, o);
      },
    });
  }
}
