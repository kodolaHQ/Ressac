// WebAiOs: guard of the content scripts of the agent's extensions (passwords, context, network). Task 13 of plan 12.
//
// Runs in the extension's isolated world, before its scripts. A content script of the agent (manifest or
// `scripting.registerContentScripts`) only declares WebAiOs files: `webaios-correctifs-page.js`, this guard,
// `webaios-portee.js` (the granted scope), then one marker per agent file (`webaios-fichiers/<n>.js`, which calls
// `__webaiosFichier(n)`). The guard then asks the background: `chrome.runtime.sendMessage({ webaios: "contexte",
// fichiers })`. The background guard asks the main process whether the sender is a tab view (never an invisible
// read); only then does it inject these files, CSS then JS, into the exact document that asked, through
// `scripting` (in this same world, after this guard). Nothing of the agent is pasted into a WebAiOs file: there is
// no wrapper to close. Consequence: `run_at` becomes "after the answer" (a round trip to the background), and without an
// answer after 20 tries, the abandonment is written to the console. The guard is set only once per world;
// `executeScript` also puts it at the head of its files.
//
// - Passwords: the `value` getter of `HTMLInputElement.prototype` returns "" for an `input[type=password]`, like
//   `defaultValue`, `getAttribute("value")`, `getAttributeNS(null, "value")` and the field's `value` `Attr` (`value`,
//   `nodeValue`, `textContent`, through `getAttributeNode` or `attributes`);
//   `new FormData(form)` removes these fields (by their name: another field of the same name goes too); a
//   `keydown`, `keypress`, `keyup`, `input`, `beforeinput`, `paste`, `composition*`, `textInput` listener (through
//   `addEventListener` or `on…`) does not receive an event whose target is a password field; `formdata`
//   is never passed on.
// - Network (spec §6.2, reasonable safeguards): `fetch`, `XMLHttpRequest.open`, `WebSocket`, `EventSource`,
//   `navigator.sendBeacon`, `window.open`, the setters `src`, `href`, `srcset`, `action`, `formAction` (and `data`,
//   `poster`, `ping`, `imageSrcset`), `setAttribute` / `setAttributeNS` and `Attr.value` of these attributes refuse an
//   address whose host is neither the page's, nor in `reseau`, nor covered by `hotes` (compared on the host
//   only: `<all_urls>` opens everything). `javascript:` and the other schemes are refused; `data:`, `blob:`, `about:`
//   and the extension's files pass.
//
// What stays open (deterrence, not a guarantee):
// - code in the page's world: an inline `<script>` inserted (`createElement("script")`, `textContent`, `append`),
//   or an `on…` attribute set by `setAttribute`, runs with no guard at all (reads the passwords, sends wherever the page's
//   CSP allows); the refusal of `world: "MAIN"` is bypassed this way;
//   (Firefox: the same door through `wrappedJSObject` and `XPCNativeWrapper.unwrap`, the page's objects without the
//   Xray: password values, listeners, the page's `fetch` and `open`.)
// - a `Worker` created from a `blob:`: its `fetch` has no guard;
// - `RTCPeerConnection` of the isolated world, with `iceServers` (STUN/TURN to any host);
// - `SVGAElement.href.baseVal`, `SVGImageElement.href.baseVal` (address set without a guarded setter);
// - markup with an address: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`; `url()` in CSS (`style`,
//   sheets); `location` (the page navigating to an address that carries data); modifying through the DOM an
//   element already present in the page without going through these setters; `Node.nodeValue` / `textContent` of an `Attr`; a
//   redirect served by a permitted site (the page's included);
// - passwords: the value copied into the `value` attribute (React) can be read through serialization (`outerHTML`,
//   `innerHTML` of an ancestor, `XMLSerializer`) and through attribute selectors (`matches('[value^="a"]')`,
//   `querySelector`); changing the field's type (`type`, `setAttribute`, `cloneNode` then changing the clone's type) and
//   then reading its value; the `pattern` + `validity.patternMismatch` oracle, character by character, without changing the
//   type; the keys of a field in a closed shadow root (target, `composedPath()[0]` and active field stop at
//   the host);
// - another frame: the isolated world of an `about:blank` frame created by the script does not have this guard, and its original
//   prototypes apply to the page's elements.
//   (Also a same-origin frame the page already has, reached through `frames[i]`: its own `FormData`, `fetch`, `XMLHttpRequest`.)
// What really protects is the whole: this guard, `webRequest` refused, the closed network of its pages and its background
// (CSP of the copy), never in a private profile, never in an invisible read (neither the agent's JS nor CSS is
// injected there).
//
// The agent's script then runs in the same world and can modify the base objects: everything the guard
// uses is captured at load, calls go through `Reflect.apply`, loops are indexed (no `split`, which
// consults `Symbol.split`), the replaced properties can be neither rewritten nor deleted, and the descriptors have
// no prototype.
(() => {
  const g = globalThis;
  const descripteur = Object.getOwnPropertyDescriptor;
  // Already set in this world (another entry, executeScript): own property, which a named element of the page does not make.
  if (descripteur(g, "__webaiosFichier")) return;
  const appliquer = Reflect.apply;
  const construire = Reflect.construct;
  const definir = Object.defineProperty;
  const creer = Object.create;
  const estListe = Array.isArray;
  const Erreur = Error;
  const ErreurType = TypeError;
  const P = typeof Promise === "function" ? Promise : null;
  const minuterie = typeof g.setTimeout === "function" ? g.setTimeout : null;
  const journal = g.console && typeof g.console.error === "function" ? g.console.error : null;
  const WM = typeof WeakMap === "function" ? WeakMap : null;
  const wmGet = WM && WM.prototype.get;
  const wmSet = WM && WM.prototype.set;
  const Url = typeof URL === "function" ? URL : null;
  const lireDe = (proto, nom) => {
    const d = proto && descripteur(proto, nom);
    return d && typeof d.get === "function" ? d.get : null;
  };
  const urlProtocole = Url && lireDe(Url.prototype, "protocol");
  const urlHote = Url && lireDe(Url.prototype, "hostname");
  const minuscules = String.prototype.toLowerCase;
  const fin = String.prototype.endsWith;
  const debut = String.prototype.startsWith;
  const tranche = String.prototype.slice;
  const indice = String.prototype.indexOf;
  const texte = (v) => `${v}`;

  const URL_REFUSEE = "URL refusée par WebAiOs";

  // --- Scope and context

  let portee = null;
  const figerSur = (objet, nom, valeur) => {
    try {
      definir(objet, nom, { __proto__: null, value: valeur, writable: false, configurable: false, enumerable: false });
      return true;
    } catch (e) {
      if (journal) appliquer(journal, g.console, [`[webaios] garde de page non posée sur ${nom} :`, e]);
      return false;
    }
  };
  // Firefox: a content script's global is a sandbox; its `window` (also `self`, `document.defaultView`) is the page's
  // window seen through an Xray, whose own members (`open`, `fetch`, `FormData`, the `on…` handlers…) are the page's.
  // Every member guarded on the global goes through `surGlobal`, which guards it on that window too.
  const fenetre = g.window && g.window !== g ? g.window : null;
  const surGlobal = (nom, valeur) => {
    figerSur(g, nom, valeur);
    if (fenetre) figerSur(fenetre, nom, valeur);
  };
  /** List of strings, copied (read once, own properties). */
  const chaines = (v) => {
    const r = [];
    if (!estListe(v)) return r;
    const d = descripteur(v, "length");
    const n = d && typeof d.value === "number" ? d.value : 0;
    for (let i = 0; i < n && i < 1000; i++) {
      const e = descripteur(v, `${i}`);
      if (e && typeof e.value === "string") r[r.length] = appliquer(minuscules, e.value, []);
    }
    return r;
  };
  figerSur(g, "__webaiosPortee", (p) => {
    if (portee !== null || p === null || typeof p !== "object") return;
    const reseau = descripteur(p, "reseau");
    const hotes = descripteur(p, "hotes");
    portee = { __proto__: null, reseau: chaines(reseau && reseau.value), hotes: chaines(hotes && hotes.value) };
  });
  const c = g.chrome;
  const runtime = c && c.runtime;
  const envoyer = runtime && typeof runtime.sendMessage === "function" ? runtime.sendMessage : null;
  const idExtension = runtime && typeof runtime.id === "string" ? runtime.id : "";
  /** The message of `chrome.runtime.lastError` during the callback (read as an own property), or null. */
  const derniereErreur = () => {
    const d = runtime ? descripteur(runtime, "lastError") : undefined;
    const e = d && "value" in d ? d.value : d && typeof d.get === "function" ? appliquer(d.get, runtime, []) : undefined;
    if (e === undefined || e === null) return null;
    const m = typeof e === "object" ? descripteur(e, "message") : undefined;
    return m && typeof m.value === "string" ? m.value : "erreur inconnue";
  };

  // The markers (`webaios-fichiers/<n>.js`) deposit the index of each agent file; once the task is done, the
  // guard asks the background to inject them. The requests go one after the other (the order of the files is kept).
  const aDemander = [];
  let prevu = false;
  let enCours = false;
  const ESSAIS_MAX = 20;
  const suivante = () => {
    if (enCours || aDemander.length === 0) return;
    if (!envoyer) {
      if (journal) appliquer(journal, g.console, ["[webaios] scripts de l'agent non lancés : chrome.runtime.sendMessage absent"]);
      aDemander.length = 0;
      return;
    }
    enCours = true;
    const lot = [];
    for (let i = 0; i < aDemander.length; i++) lot[lot.length] = aDemander[i];
    aDemander.length = 0;
    let essais = 0;
    const finir = () => {
      enCours = false;
      suivante();
    };
    const essayer = () => {
      essais++;
      const relancer = (raison) => {
        if (essais < ESSAIS_MAX && minuterie) {
          appliquer(minuterie, g, [essayer, 250]);
          return;
        }
        if (journal) appliquer(journal, g.console, [`[webaios] scripts de l'agent non lancés après ${essais} essais : ${raison}`]);
        finir();
      };
      try {
        appliquer(envoyer, runtime, [
          { __proto__: null, webaios: "contexte", fichiers: lot },
          (r) => {
            // Read during the callback: otherwise Chromium writes "Unchecked runtime.lastError".
            const erreur = derniereErreur();
            const d = r !== null && typeof r === "object" ? descripteur(r, "onglet") : undefined;
            if (d && "value" in d) return finir();
            relancer(erreur || "pas de réponse du fond");
          },
        ]);
      } catch (e) {
        relancer(`${e && e.message}`);
      }
    };
    essayer();
  };
  figerSur(g, "__webaiosFichier", (n) => {
    if (typeof n !== "number") return;
    aDemander[aDemander.length] = n;
    if (prevu) return;
    prevu = true;
    const partir = () => {
      prevu = false;
      suivante();
    };
    if (minuterie) appliquer(minuterie, g, [partir, 0]);
    else partir();
  });

  // --- Addresses

  // The document's origin, read now (`origin` can be replaced in this world, `location` cannot).
  let hotePage = "";
  try {
    hotePage = appliquer(minuscules, texte(g.location.hostname), []);
  } catch {
    hotePage = "";
  }
  const docBase = g.Node && lireDe(g.Node.prototype, "baseURI");
  const document = g.document;
  /** The host of a Chrome pattern (`<all_urls>`: "*", `https://*.x.test/*`: "*.x.test"), or null. */
  const hoteDuMotif = (m) => {
    if (m === "<all_urls>") return "*";
    const i = appliquer(indice, m, ["://"]);
    if (i < 0) return null;
    const schema = appliquer(tranche, m, [0, i]);
    if (schema !== "*" && schema !== "http" && schema !== "https" && schema !== "ws" && schema !== "wss") return null;
    const reste = appliquer(tranche, m, [i + 3]);
    const j = appliquer(indice, reste, ["/"]);
    let hote = j < 0 ? reste : appliquer(tranche, reste, [0, j]);
    const k = appliquer(indice, hote, [":"]);
    if (k >= 0) hote = appliquer(tranche, hote, [0, k]);
    return hote;
  };
  const hotePermis = (hote) => {
    if (!hote) return false;
    if (hote === hotePage) return true;
    if (!portee) return false;
    for (let i = 0; i < portee.reseau.length; i++) if (portee.reseau[i] === hote) return true;
    for (let i = 0; i < portee.hotes.length; i++) {
      const h = hoteDuMotif(portee.hotes[i]);
      if (h === null) continue;
      if (h === "*" || h === hote) return true;
      if (appliquer(debut, h, ["*."])) {
        const racine = appliquer(tranche, h, [2]);
        if (hote === racine || appliquer(fin, hote, [`.${racine}`])) return true;
      }
    }
    return false;
  };
  /**
   * Is the address (relative: to the document) allowed? `reseau`: only http(s)/ws(s) to an allowed host
   * (window.open); otherwise `data:`, `blob:`, `about:` and the extension itself pass too.
   */
  const permise = (brute, reseauSeul) => {
    if (!Url || !urlProtocole || !urlHote) return false;
    let u;
    try {
      const base = docBase && document ? appliquer(docBase, document, []) : undefined;
      u = base === undefined ? new Url(brute) : new Url(brute, base);
    } catch {
      // Unreadable: nothing will go to it (neither fetch nor element will resolve it any better).
      return true;
    }
    const schema = appliquer(urlProtocole, u, []);
    if (schema === "http:" || schema === "https:" || schema === "ws:" || schema === "wss:") return hotePermis(appliquer(urlHote, u, []));
    if (reseauSeul) return false;
    if (schema === "data:" || schema === "blob:" || schema === "about:") return true;
    if (schema === "chrome-extension:") return !!idExtension && appliquer(urlHote, u, []) === idExtension;
    return false;
  };
  /**
   * Each piece of a `srcset` / `ping`, cut at whitespace and commas (stricter than the browser). Walked
   * character by character: `split` would consult `Symbol.split`, which the agent's script can set.
   */
  const SEPARATEURS = { __proto__: null, " ": 1, "\t": 1, "\n": 1, "\r": 1, "\f": 1, ",": 1 };
  const listePermise = (valeur) => {
    const n = valeur.length;
    let depart = 0;
    for (let i = 0; i <= n; i++) {
      if (i < n && !SEPARATEURS[valeur[i]]) continue;
      if (i > depart && !permise(appliquer(tranche, valeur, [depart, i]), false)) return false;
      depart = i + 1;
    }
    return true;
  };
  const ATTRIBUTS = { __proto__: null, src: 1, href: 1, "xlink:href": 1, action: 1, formaction: 1, data: 1, poster: 1, background: 1, srcset: 2, imagesrcset: 2, ping: 2 };
  const attributPermis = (nom, valeur) => {
    const n = ATTRIBUTS[appliquer(minuscules, texte(nom), [])];
    if (!n) return true;
    return n === 2 ? listePermise(valeur) : permise(valeur, false);
  };

  // --- Passwords

  const HIE = g.HTMLInputElement;
  const typeDe = HIE && lireDe(HIE.prototype, "type");
  const estMotDePasse = (n) => {
    if (!typeDe || n === null || typeof n !== "object") return false;
    try {
      return appliquer(typeDe, n, []) === "password";
    } catch {
      return false;
    }
  };
  if (HIE && typeDe) {
    const d = descripteur(HIE.prototype, "value");
    if (d && typeof d.get === "function") {
      const lire = d.get;
      definir(HIE.prototype, "value", {
        __proto__: null,
        get: function () {
          const v = appliquer(lire, this, []);
          return estMotDePasse(this) ? "" : v;
        },
        set: d.set,
        enumerable: d.enumerable,
        configurable: false,
      });
    }
  }

  // The value copied into the `value` attribute (React, others): `getAttribute`, `getAttributeNS`, the `Attr` (`value`,
  // `nodeValue`, `textContent`, through `getAttributeNode` or `attributes`) and `defaultValue` return "" for a password
  // field. Still open: serialization (`outerHTML`, `innerHTML` of an ancestor) and attribute selectors
  // (`matches('[value^="a"]')`, `querySelector`).
  const AttrP = g.Attr && g.Attr.prototype;
  const nomDAttr = AttrP && lireDe(AttrP, "name");
  const proprioDAttr = AttrP && lireDe(AttrP, "ownerElement");
  const estValeur = (nom) => typeof nom === "string" && appliquer(minuscules, nom, []) === "value";
  /** True if `a` is the `value` attribute of a password field (false for anything that is not an `Attr`). */
  const attrMasque = (a) => {
    if (!nomDAttr || !proprioDAttr || a === null || typeof a !== "object") return false;
    try {
      return estValeur(appliquer(nomDAttr, a, [])) && estMotDePasse(appliquer(proprioDAttr, a, []));
    } catch {
      return false;
    }
  };
  const masquerGetter = (proto, nom, masque) => {
    const d = proto && descripteur(proto, nom);
    if (!d || typeof d.get !== "function") return;
    const lire = d.get;
    try {
      definir(proto, nom, {
        __proto__: null,
        get: function () {
          const v = appliquer(lire, this, []);
          return masque(this) ? "" : v;
        },
        set: d.set,
        enumerable: d.enumerable,
        configurable: false,
      });
    } catch (e) {
      if (journal) appliquer(journal, g.console, [`[webaios] garde de page non posée sur ${nom} :`, e]);
    }
  };
  if (HIE && typeDe) masquerGetter(HIE.prototype, "defaultValue", estMotDePasse);
  if (g.Node) {
    masquerGetter(g.Node.prototype, "nodeValue", attrMasque);
    masquerGetter(g.Node.prototype, "textContent", attrMasque);
  }
  const ElP = g.Element && g.Element.prototype;
  if (ElP && typeDe) {
    const lireAttr = ElP.getAttribute;
    const lireAttrNS = ElP.getAttributeNS;
    if (typeof lireAttr === "function") {
      figerSur(ElP, "getAttribute", function getAttribute(nom) {
        // The name is converted only once: an object whose `toString` changes does not pass between the two reads.
        const n = texte(nom);
        const v = appliquer(lireAttr, this, [n]);
        return v !== null && estMotDePasse(this) && estValeur(n) ? "" : v;
      });
    }
    if (typeof lireAttrNS === "function") {
      figerSur(ElP, "getAttributeNS", function getAttributeNS(ns, nom) {
        const n = texte(nom);
        const v = appliquer(lireAttrNS, this, [ns, n]);
        return v !== null && estMotDePasse(this) && estValeur(n) ? "" : v;
      });
    }
  }

  const FD = g.FormData;
  const HFE = g.HTMLFormElement;
  const elementsDe = HFE && lireDe(HFE.prototype, "elements");
  const longueurCollection = g.HTMLCollection && lireDe(g.HTMLCollection.prototype, "length");
  const nomDe = HIE && lireDe(HIE.prototype, "name");
  const retirerFD = FD && FD.prototype.delete;
  if (FD && elementsDe && longueurCollection && nomDe && typeof retirerFD === "function") {
    const Enveloppe = function FormData(...a) {
      if (new.target === undefined) throw new ErreurType("Failed to construct 'FormData': Please use the 'new' operator.");
      const fd = construire(FD, a, new.target);
      if (a.length > 0 && a[0] !== undefined) {
        const els = appliquer(elementsDe, a[0], []);
        const n = appliquer(longueurCollection, els, []);
        for (let i = 0; i < n; i++) {
          const el = els[i];
          if (!estMotDePasse(el)) continue;
          const nom = appliquer(nomDe, el, []);
          if (nom) appliquer(retirerFD, fd, [nom]);
        }
      }
      return fd;
    };
    definir(Enveloppe, "prototype", { __proto__: null, value: FD.prototype, writable: false, configurable: false, enumerable: false });
    figerSur(FD.prototype, "constructor", Enveloppe);
    surGlobal("FormData", Enveloppe);
  }

  const lireCible = g.Event && lireDe(g.Event.prototype, "target");
  const chemin = g.Event && g.Event.prototype.composedPath;
  const actifDe = g.Document && lireDe(g.Document.prototype, "activeElement");
  const ombreDe = g.Element && lireDe(g.Element.prototype, "shadowRoot");
  const actifOmbre = g.ShadowRoot && lireDe(g.ShadowRoot.prototype, "activeElement");
  const FILTRES = { __proto__: null, keydown: 1, keypress: 1, keyup: 1, input: 1, beforeinput: 1, paste: 1, compositionstart: 1, compositionupdate: 1, compositionend: 1, textinput: 1, formdata: 2 };
  /** The active field, through the open shadow roots. */
  const actifProfond = () => {
    if (!actifDe || !document) return null;
    let a = appliquer(actifDe, document, []);
    for (let i = 0; i < 32 && a; i++) {
      const r = ombreDe ? appliquer(ombreDe, a, []) : null;
      const b = r && actifOmbre ? appliquer(actifOmbre, r, []) : null;
      if (!b) break;
      a = b;
    }
    return a;
  };
  /** Must the event be hidden from the agent's listener? */
  const cache = (type, e) => {
    const f = FILTRES[type];
    if (!f) return false;
    if (f === 2) return true;
    try {
      if (lireCible && estMotDePasse(appliquer(lireCible, e, []))) return true;
      const p = chemin ? appliquer(chemin, e, []) : null;
      if (p && p.length > 0 && estMotDePasse(p[0])) return true;
      return estMotDePasse(actifProfond());
    } catch {
      return true;
    }
  };
  const nomType = (t) => appliquer(minuscules, texte(t), []);
  const envelopperEcouteur = (type, l) =>
    function (e) {
      if (cache(type, e)) return undefined;
      if (typeof l === "function") return appliquer(l, this, [e]);
      const h = l && l.handleEvent;
      return typeof h === "function" ? appliquer(h, l, [e]) : undefined;
    };

  const ET = g.EventTarget;
  if (ET && WM) {
    const ajouter = ET.prototype.addEventListener;
    const retirer = ET.prototype.removeEventListener;
    // Listener → { "<type>|<capture>": wrapper }: the same wrapper for the same triplet (removal, duplicates).
    const enveloppes = new WM();
    const enveloppeDe = (type, l, options, creerSiAbsente) => {
      if (l === null || (typeof l !== "object" && typeof l !== "function")) return null;
      let capture = false;
      if (typeof options === "boolean") capture = options;
      else if (options !== null && typeof options === "object") capture = !!options.capture;
      const cle = `${type}|${capture}`;
      let table = appliquer(wmGet, enveloppes, [l]);
      if (!table) {
        if (!creerSiAbsente) return null;
        table = creer(null);
        appliquer(wmSet, enveloppes, [l, table]);
      }
      if (!table[cle] && creerSiAbsente) table[cle] = envelopperEcouteur(type, l);
      return table[cle] || null;
    };
    if (typeof ajouter === "function" && typeof retirer === "function") {
      figerSur(ET.prototype, "addEventListener", function addEventListener(type, l, options) {
        const t = texte(type);
        if (!FILTRES[nomType(t)]) return appliquer(ajouter, this, [t, l, options]);
        const w = enveloppeDe(nomType(t), l, options, true);
        return appliquer(ajouter, this, [t, w || l, options]);
      });
      figerSur(ET.prototype, "removeEventListener", function removeEventListener(type, l, options) {
        const t = texte(type);
        if (!FILTRES[nomType(t)]) return appliquer(retirer, this, [t, l, options]);
        const w = enveloppeDe(nomType(t), l, options, false);
        return appliquer(retirer, this, [t, w || l, options]);
      });
    }
    // The `on…` handlers: the agent reads back the function it set, the page receives the wrapper.
    const posees = new WM();
    const NOMS_ON = ["onkeydown", "onkeypress", "onkeyup", "oninput", "onbeforeinput", "onpaste", "onformdata"];
    const protos = [g.HTMLElement, g.SVGElement, g.MathMLElement, g.Document, g.Window];
    const surProto = (o, nom) => {
      const d = o && descripteur(o, nom);
      if (!d || typeof d.set !== "function" || typeof d.get !== "function") return;
      const lire = d.get;
      const ecrire = d.set;
      const type = appliquer(tranche, nom, [2]);
      definir(o, nom, {
        __proto__: null,
        get: function () {
          const v = appliquer(lire, this, []);
          const table = appliquer(wmGet, posees, [this]);
          return table && table[nom] && table[nom].enveloppe === v ? table[nom].fonction : v;
        },
        set: function (f) {
          if (typeof f !== "function") return appliquer(ecrire, this, [f]);
          const w = envelopperEcouteur(type, f);
          let table = appliquer(wmGet, posees, [this]);
          if (!table) {
            table = creer(null);
            appliquer(wmSet, posees, [this, table]);
          }
          table[nom] = { __proto__: null, fonction: f, enveloppe: w };
          return appliquer(ecrire, this, [w]);
        },
        enumerable: d.enumerable,
        configurable: false,
      });
    };
    for (let i = 0; i < NOMS_ON.length; i++) {
      for (let j = 0; j < protos.length; j++) surProto(protos[j] && protos[j].prototype, NOMS_ON[i]);
      surProto(g, NOMS_ON[i]);
      if (fenetre) surProto(fenetre, NOMS_ON[i]);
    }
  }

  // --- Network

  const refusee = () => new Erreur(URL_REFUSEE);
  const reqUrl = g.Request && lireDe(g.Request.prototype, "url");
  const fetchNatif = typeof g.fetch === "function" ? g.fetch : null;
  if (fetchNatif && P) {
    surGlobal("fetch", function fetch(entree, init) {
      let u = null;
      if (reqUrl && entree !== null && typeof entree === "object") {
        try {
          u = appliquer(reqUrl, entree, []);
        } catch {
          u = null;
        }
      }
      // Not a request: the address is read once, and that is the one that goes.
      const cible = u === null ? texte(entree) : entree;
      if (!permise(u === null ? cible : u, false)) return new P((_ok, ko) => ko(new ErreurType(URL_REFUSEE)));
      return appliquer(fetchNatif, g, arguments.length > 1 ? [cible, init] : [cible]);
    });
  }
  const XHR = g.XMLHttpRequest;
  if (XHR && typeof XHR.prototype.open === "function") {
    const ouvrir = XHR.prototype.open;
    figerSur(XHR.prototype, "open", function open(methode, url, ...reste) {
      const u = texte(url);
      if (!permise(u, false)) throw refusee();
      return appliquer(ouvrir, this, [methode, u, ...reste]);
    });
    // Firefox: the sandbox's own XMLHttpRequest (guarded prototype) replaces the page's on the Xray window.
    if (fenetre && fenetre.XMLHttpRequest !== XHR) figerSur(fenetre, "XMLHttpRequest", XHR);
  }
  /** Replaces a constructor (`WebSocket`, `EventSource`): the address (first argument) is checked first. */
  const garderConstructeur = (nom) => {
    const C = g[nom];
    if (typeof C !== "function") return;
    const Enveloppe = function (url, ...reste) {
      if (new.target === undefined) throw new ErreurType(`Failed to construct '${nom}': Please use the 'new' operator.`);
      const u = texte(url);
      if (!permise(u, false)) throw refusee();
      return construire(C, [u, ...reste], new.target);
    };
    definir(Enveloppe, "name", { __proto__: null, value: nom });
    definir(Enveloppe, "prototype", { __proto__: null, value: C.prototype, writable: false, configurable: false, enumerable: false });
    const constantes = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    for (let i = 0; i < constantes.length; i++) {
      const d = descripteur(C, constantes[i]);
      if (d) definir(Enveloppe, constantes[i], { __proto__: null, value: d.value, enumerable: true });
    }
    figerSur(C.prototype, "constructor", Enveloppe);
    surGlobal(nom, Enveloppe);
  };
  garderConstructeur("WebSocket");
  garderConstructeur("EventSource");
  const Nav = g.Navigator;
  if (Nav && typeof Nav.prototype.sendBeacon === "function") {
    const balise = Nav.prototype.sendBeacon;
    figerSur(Nav.prototype, "sendBeacon", function sendBeacon(url, ...reste) {
      const u = texte(url);
      if (!permise(u, false)) return false;
      return appliquer(balise, this, [u, ...reste]);
    });
  }
  const dOuvrir = descripteur(g, "open") || (fenetre && descripteur(fenetre, "open")) || (g.Window && descripteur(g.Window.prototype, "open"));
  const ouvrirFenetre = dOuvrir && typeof dOuvrir.value === "function" ? dOuvrir.value : null;
  if (ouvrirFenetre) {
    // An empty window could then be led elsewhere (its `location` is writable from another origin): refused.
    const open = function open(url, ...reste) {
      const u = url === undefined ? "" : texte(url);
      if (!permise(u === "" ? "about:blank" : u, true)) return null;
      return appliquer(ouvrirFenetre, this === g ? fenetre || g : this, [u, ...reste]);
    };
    surGlobal("open", open);
  }
  /** The address setters of an element class. */
  const garderSetters = (classe, noms) => {
    const C = g[classe];
    const proto = C && C.prototype;
    if (!proto) return;
    for (let i = 0; i < noms.length; i++) {
      const d = descripteur(proto, noms[i]);
      if (!d || typeof d.set !== "function") continue;
      const ecrire = d.set;
      const nom = noms[i];
      const liste = nom === "srcset" || nom === "imageSrcset" || nom === "ping";
      definir(proto, nom, {
        __proto__: null,
        get: d.get,
        set: function (v) {
          const s = texte(v);
          if (!(liste ? listePermise(s) : permise(s, false))) throw refusee();
          return appliquer(ecrire, this, [s]);
        },
        enumerable: d.enumerable,
        configurable: false,
      });
    }
  };
  garderSetters("HTMLImageElement", ["src", "srcset"]);
  garderSetters("HTMLSourceElement", ["src", "srcset"]);
  garderSetters("HTMLScriptElement", ["src"]);
  garderSetters("HTMLIFrameElement", ["src"]);
  garderSetters("HTMLFrameElement", ["src"]);
  garderSetters("HTMLEmbedElement", ["src"]);
  garderSetters("HTMLMediaElement", ["src"]);
  garderSetters("HTMLTrackElement", ["src"]);
  garderSetters("HTMLVideoElement", ["poster"]);
  garderSetters("HTMLInputElement", ["src", "formAction"]);
  garderSetters("HTMLButtonElement", ["formAction"]);
  garderSetters("HTMLFormElement", ["action"]);
  garderSetters("HTMLAnchorElement", ["href", "ping"]);
  garderSetters("HTMLAreaElement", ["href", "ping"]);
  garderSetters("HTMLLinkElement", ["href", "imageSrcset"]);
  garderSetters("HTMLBaseElement", ["href"]);
  garderSetters("HTMLObjectElement", ["data"]);
  const El = g.Element;
  if (El) {
    const poser = El.prototype.setAttribute;
    const poserNS = El.prototype.setAttributeNS;
    if (typeof poser === "function") {
      figerSur(El.prototype, "setAttribute", function setAttribute(nom, valeur) {
        const n = texte(nom);
        const v = texte(valeur);
        if (!attributPermis(n, v)) throw refusee();
        return appliquer(poser, this, [n, v]);
      });
    }
    if (typeof poserNS === "function") {
      figerSur(El.prototype, "setAttributeNS", function setAttributeNS(ns, nom, valeur) {
        const n = texte(nom);
        const v = texte(valeur);
        const k = appliquer(indice, n, [":"]);
        if (!attributPermis(n, v) || !attributPermis(k < 0 ? n : appliquer(tranche, n, [k + 1]), v)) throw refusee();
        return appliquer(poserNS, this, [ns, n, v]);
      });
    }
  }
  const Attr = g.Attr;
  const dValeur = Attr && descripteur(Attr.prototype, "value");
  const nomAttr = Attr && lireDe(Attr.prototype, "name");
  if (dValeur && typeof dValeur.set === "function" && nomAttr) {
    const ecrire = dValeur.set;
    const lireValeur = dValeur.get;
    definir(Attr.prototype, "value", {
      __proto__: null,
      // Passwords: the `value` attribute of a password field reads empty (see above).
      get:
        typeof lireValeur === "function"
          ? function () {
              const v = appliquer(lireValeur, this, []);
              return attrMasque(this) ? "" : v;
            }
          : lireValeur,
      set: function (v) {
        const s = texte(v);
        if (!attributPermis(appliquer(nomAttr, this, []), s)) throw refusee();
        return appliquer(ecrire, this, [s]);
      },
      enumerable: dValeur.enumerable,
      configurable: false,
    });
  }
})();
