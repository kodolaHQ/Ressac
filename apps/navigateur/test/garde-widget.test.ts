import { afterEach, expect, test } from "vitest";
import { contientIndiceReseau, MOTIF_INDICES_RESEAU } from "../src/commun/indices-reseau";
import { gardeWidget } from "../src/preload/garde-widget";

const INDICES = [
  '<link rel="dns-prefetch" href="//x.secret.example">',
  "<LINK rel=preconnect href=https://x.secret.example>",
  "< link rel=dns-prefetch>",
  '<link\nrel="dns-prefetch">',
  '<meta http-equiv="x-dns-prefetch-control" content="on">',
  "<meta content=\">\" HTTP-EQUIV=refresh>",
  '<iframe srcdoc="&lt;link rel=dns-prefetch href=//x.secret.example&gt;"></iframe>',
  '<iframe srcdoc="&amp;lt;link rel=dns-prefetch&amp;gt;"></iframe>',
  '<iframe srcdoc="&#60;link rel=dns-prefetch>"></iframe>',
  '<iframe srcdoc="&#x3C;link rel=dns-prefetch>"></iframe>',
  '<script type="speculationrules">{}</script>',
];
const SAINS = ['<meta charset="utf-8">', "<b>gras</b> &amp; <i>texte</i>", "<linked-list></linked-list>", '<a href="https://exemple.fr">lien</a>', "<p>a &lt; b</p>"];

test("contientIndiceReseau : <link>, <meta http-equiv> et règles de spéculation, même encodés dans un srcdoc", () => {
  for (const h of INDICES) expect(contientIndiceReseau(h), h).toBe(true);
  for (const h of SAINS) expect(contientIndiceReseau(h), h).toBe(false);
});

// Une fenêtre factice : juste ce que touche la garde.
const avant = (globalThis as { window?: unknown }).window;
afterEach(() => {
  (globalThis as { window?: unknown }).window = avant;
});

function fenetreFactice() {
  class Document {
    createElement(nom: string, _o?: unknown) {
      return { nom };
    }
    createElementNS(_ns: string, nom: string) {
      return { nom };
    }
  }
  class CustomElementRegistry {
    definis: string[] = [];
    define(nom: string, _classe?: unknown, _o?: unknown) {
      this.definis.push(nom);
    }
  }
  let politique: Record<string, (s: string) => unknown> | undefined;
  const w: Record<string, any> = {
    RTCPeerConnection: class {},
    webkitRTCPeerConnection: class {},
    RTCDataChannel: class {},
    XSLTProcessor: class {},
    Document,
    CustomElementRegistry,
    Element: { prototype: { setHTML() {} } },
    ShadowRoot: { prototype: { setHTML() {} } },
    trustedTypes: {
      createPolicy(nom: string, p: Record<string, (s: string) => unknown>) {
        if (nom !== "default") throw new Error("nom");
        politique = p;
      },
    },
  };
  (globalThis as { window?: unknown }).window = w;
  return { w, politique: () => politique!, document: new Document(), registre: new CustomElementRegistry() };
}

test("gardeWidget : ni WebRTC, ni XSLT, ni setHTML ; HTML avec indice réseau et code en texte refusés ; <link> et <meta> refusés au DOM", () => {
  const { w, politique, document, registre } = fenetreFactice();
  // Sérialisée par Electron : la garde ne doit dépendre de rien d'extérieur.
  const serialisee = new Function(`return (${gardeWidget.toString()})`)() as typeof gardeWidget;
  serialisee(MOTIF_INDICES_RESEAU);
  for (const nom of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "XSLTProcessor"]) expect(w[nom], nom).toBeUndefined();
  expect(w.Element.prototype.setHTML).toBeUndefined();
  expect(w.ShadowRoot.prototype.setHTML).toBeUndefined();
  const p = politique();
  for (const h of INDICES) expect(() => p.createHTML!(h), h).toThrow(/Refusé/);
  for (const h of SAINS) expect(p.createHTML!(h)).toBe(h);
  expect(() => p.createScript!("top.postMessage(1)")).toThrow(/Refusé/);
  expect(() => p.createScriptURL!("https://x.fr/a.js")).toThrow(/Refusé/);
  for (const nom of ["link", "LINK", "meta", "svg:link"]) {
    expect(() => document.createElement(nom), nom).toThrow(/Refusé/);
    expect(() => document.createElementNS("http://www.w3.org/1999/xhtml", nom), nom).toThrow(/Refusé/);
  }
  expect(document.createElement("div")).toEqual({ nom: "div" });
  expect(document.createElementNS("http://www.w3.org/2000/svg", "svg")).toEqual({ nom: "svg" });
  expect(() => registre.define("x-lien", class {}, { extends: "link" })).toThrow(/Refusé/);
  registre.define("x-ok", class {});
  expect(registre.definis).toEqual(["x-ok"]);
});
