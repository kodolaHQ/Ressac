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
  // Contournement relevé à la revue : srcdoc imbriqué, & écrit en référence numérique.
  "<iframe srcdoc=\"<iframe srcdoc='&#38;lt;link rel=dns-prefetch href=//x.evil.tld>'></iframe>\"></iframe>",
  "<iframe srcdoc='&#x26;lt;link rel=dns-prefetch>'></iframe>",
  "<iframe srcdoc='&#38;#60;link rel=dns-prefetch>'></iframe>",
  "<iframe srcdoc='&lt;meta http&#45;equiv=x-dns-prefetch-control content=on&gt;'></iframe>",
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
  class Node {
    constructor(
      readonly t: number,
      readonly nom = "",
      readonly enfants: Node[] = [],
    ) {}
    get nodeType() {
      return this.t;
    }
    appendChild(n: Node) {
      this.enfants.push(n);
      return n;
    }
  }
  const chercher = function (this: Node, sel: string): Node | null {
    const noms = sel.split(",");
    const visiter = (n: Node): Node | null => {
      for (const e of n.enfants) {
        if (noms.includes(e.nom)) return e;
        const x = visiter(e);
        if (x) return x;
      }
      return null;
    };
    return visiter(this);
  };
  class Element extends Node {
    get localName() {
      return this.nom;
    }
    querySelector(sel: string) {
      return chercher.call(this, sel);
    }
    append(...n: (Node | string)[]) {
      this.enfants.push(...(n as Node[]));
    }
    setHTML() {}
  }
  class DocumentFragment extends Node {
    querySelector(sel: string) {
      return chercher.call(this, sel);
    }
  }
  class Document {
    execCommand(_nom: string, _ui?: boolean, _valeur?: string) {
      return true;
    }
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
    Node,
    Element,
    DocumentFragment,
    ShadowRoot: { prototype: { setHTML() {} } },
    trustedTypes: {
      createPolicy(nom: string, p: Record<string, (s: string) => unknown>) {
        if (nom !== "default") throw new Error("nom");
        politique = p;
      },
    },
  };
  (globalThis as { window?: unknown }).window = w;
  return { w, politique: () => politique!, document: new Document(), registre: new CustomElementRegistry(), Element, DocumentFragment };
}

test("gardeWidget : ni WebRTC, ni XSLT, ni setHTML ; HTML avec indice réseau et code en texte refusés ; <link> et <meta> refusés au DOM", () => {
  const { w, politique, document, registre, Element, DocumentFragment } = fenetreFactice();
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
  // Insertion : un <link> ou un <meta> venu d'ailleurs (createDocument + adoptNode…), seul ou dans un fragment, est refusé.
  const tete = new Element(1, "head");
  expect(() => tete.appendChild(new Element(1, "link"))).toThrow(/Refusé/);
  expect(() => tete.append(new Element(1, "META"))).toThrow(/Refusé/);
  expect(() => tete.append(new DocumentFragment(11, "", [new Element(1, "div", [new Element(1, "link")])]))).toThrow(/Refusé/);
  expect(() => tete.append(new Element(1, "div", [new Element(1, "meta")]))).toThrow(/Refusé/);
  tete.append(new Element(1, "div", [new Element(1, "p")]), "texte");
  tete.appendChild(new Element(1, "p"));
  expect((tete.enfants as unknown[]).map((e) => (typeof e === "string" ? e : (e as { nom: string }).nom))).toEqual(["div", "texte", "p"]);
  expect(() => (document as any).execCommand("insertHTML", false, "<link rel=dns-prefetch>")).toThrow(/Refusé/);
  expect((document as any).execCommand("insertHTML", false, "<b>ok</b>")).toBe(true);
});
