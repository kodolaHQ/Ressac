// WebAiOs : garde des scripts de contenu des extensions de l'agent (mots de passe, contexte, réseau). Tâche 13 du plan 12.
//
// Tourne dans le monde isolé de l'extension, avant ses scripts : en tête de chaque `webaios-cs-<i>.js` (écrit par la
// copie contrôlée : correctifs, cette garde, la portée, puis les fichiers de l'agent dans `__webaiosApres(() => { … })`),
// et en premier fichier de `scripting.executeScript` / `registerContentScripts` (webaios-garde-fond.js). Posée une
// seule fois par monde : les suivantes ne font rien.
//
// - Mots de passe : le getter `value` de `HTMLInputElement.prototype` rend "" pour un `input[type=password]` ;
//   `new FormData(form)` en retire ces champs (par leur nom : un autre champ du même nom part aussi) ; un écouteur
//   `keydown`, `keypress`, `keyup`, `input`, `beforeinput`, `paste`, `composition*`, `textInput` (par
//   `addEventListener` ou par `on…`) ne reçoit pas un événement dont la cible est un champ de mot de passe ; `formdata`
//   n'est jamais transmis.
// - Contexte : `chrome.runtime.sendMessage({ webaios: "contexte" })`, auquel répond le garde du fond (le processus
//   principal dit si l'onglet est une vue d'onglet, jamais une lecture invisible). Tant que la réponse n'est pas
//   `{ onglet: true }`, les fonctions passées à `__webaiosApres` (les scripts de l'agent) sont retenues ; jamais
//   appelées sinon.
// - Réseau (spec §6.2, garde-fous raisonnables) : `fetch`, `XMLHttpRequest.open`, `WebSocket`, `EventSource`,
//   `navigator.sendBeacon`, `window.open`, les setters `src`, `href`, `srcset`, `action`, `formAction` (et `data`,
//   `poster`, `ping`, `imageSrcset`), `setAttribute` / `setAttributeNS` et `Attr.value` de ces attributs refusent une
//   adresse dont l'hôte n'est ni celui de la page, ni dans `reseau`, ni couvert par `hotes` (la portée accordée, posée
//   par `__webaiosPortee`). `javascript:` et les autres schémas sont refusés ; `data:`, `blob:`, `about:` et les
//   fichiers de l'extension passent (rien ne sort).
//
// Ce qui reste ouvert (dissuasion, pas garantie) :
// - le script peut changer le type du champ (`type`, `setAttribute`, `cloneNode` puis changer le type du double) et lire
//   ensuite sa valeur ; il peut passer par un autre cadre (le monde isolé d'un cadre `about:blank` qu'il crée n'a pas
//   cette garde) ;
// - `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` (balisage avec `src`), `url()` en CSS (`style`,
//   feuilles), `location` (navigation de la page vers une adresse qui porte des données), modifier par le DOM un
//   élément de la page déjà présent sans passer par ces setters, `Node.nodeValue` / `textContent` d'un `Attr`, une
//   redirection servie par un site permis.
// Ce qui protège vraiment est l'ensemble : cette garde, `webRequest` refusé, le réseau fermé de ses pages et de son fond
// (CSP de la copie), jamais dans un profil privé, jamais dans une lecture invisible.
//
// Le script de l'agent tourne ensuite dans le même monde et peut modifier les objets de base : tout ce dont la garde se
// sert est saisi au chargement, les appels passent par `Reflect.apply`, les boucles sont indexées, les propriétés
// remplacées ne sont ni réécrivables ni supprimables, et les descripteurs n'ont pas de prototype.
(() => {
  const g = globalThis;
  const descripteur = Object.getOwnPropertyDescriptor;
  // Déjà posée dans ce monde (autre entrée, executeScript) : propriété propre, qu'un élément nommé de la page ne fait pas.
  if (descripteur(g, "__webaiosApres")) return;
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
  const signaler = typeof g.reportError === "function" ? g.reportError : null;
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
  const decouper = String.prototype.split;
  const texte = (v) => `${v}`;

  const URL_REFUSEE = "URL refusée par WebAiOs";
  const rapporter = (e) => {
    try {
      if (signaler) appliquer(signaler, g, [e]);
      else if (journal) appliquer(journal, g.console, [e]);
    } catch {
      // Rien de plus à faire.
    }
  };

  // --- Portée et contexte

  let portee = null;
  /** null : pas encore de réponse ; true : un onglet ; false : jamais (lecture invisible, autre vue). */
  let verdict = null;
  const enAttente = [];
  const lancer = (f) => {
    try {
      appliquer(f, undefined, []);
    } catch (e) {
      rapporter(e);
    }
  };
  const figerSur = (objet, nom, valeur) => {
    try {
      definir(objet, nom, { __proto__: null, value: valeur, writable: false, configurable: false, enumerable: false });
      return true;
    } catch (e) {
      if (journal) appliquer(journal, g.console, [`[webaios] garde de page non posée sur ${nom} :`, e]);
      return false;
    }
  };
  /** Liste de chaînes, recopiée (lue une fois, propriétés propres). */
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
  figerSur(g, "__webaiosApres", (f) => {
    if (typeof f !== "function") return;
    if (verdict === true) lancer(f);
    else if (verdict === null) enAttente[enAttente.length] = f;
  });

  const c = g.chrome;
  const runtime = c && c.runtime;
  const envoyer = runtime && typeof runtime.sendMessage === "function" ? runtime.sendMessage : null;
  const idExtension = runtime && typeof runtime.id === "string" ? runtime.id : "";
  let essais = 0;
  const demander = () => {
    if (!envoyer) return;
    essais++;
    try {
      appliquer(envoyer, runtime, [
        { __proto__: null, webaios: "contexte" },
        (r) => {
          if (verdict !== null) return;
          const d = r !== null && typeof r === "object" ? descripteur(r, "onglet") : undefined;
          if (d && "value" in d) {
            verdict = d.value === true;
            if (verdict) for (let i = 0; i < enAttente.length; i++) lancer(enAttente[i]);
            enAttente.length = 0;
            return;
          }
          // Pas de réponse (fond qui démarre) : redemandé un peu plus tard, quelques fois.
          if (essais < 20 && minuterie) appliquer(minuterie, g, [demander, 250]);
        },
      ]);
    } catch {
      if (essais < 20 && minuterie) appliquer(minuterie, g, [demander, 250]);
    }
  };

  // --- Adresses

  // L'origine du document, lue maintenant (`origin` est remplaçable dans ce monde, `location` non).
  let hotePage = "";
  try {
    hotePage = appliquer(minuscules, texte(g.location.hostname), []);
  } catch {
    hotePage = "";
  }
  const docBase = g.Node && lireDe(g.Node.prototype, "baseURI");
  const document = g.document;
  /** L'hôte d'un motif de Chrome (`<all_urls>` : "*", `https://*.x.test/*` : "*.x.test"), ou null. */
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
   * L'adresse (relative : au document) est-elle permise ? `reseau` : seulement http(s)/ws(s) vers un hôte permis
   * (window.open) ; sinon `data:`, `blob:`, `about:` et l'extension elle-même passent aussi.
   */
  const permise = (brute, reseauSeul) => {
    if (!Url || !urlProtocole || !urlHote) return false;
    let u;
    try {
      const base = docBase && document ? appliquer(docBase, document, []) : undefined;
      u = base === undefined ? new Url(brute) : new Url(brute, base);
    } catch {
      // Illisible : rien ne partira vers elle (ni fetch ni élément ne la résoudront mieux).
      return true;
    }
    const schema = appliquer(urlProtocole, u, []);
    if (schema === "http:" || schema === "https:" || schema === "ws:" || schema === "wss:") return hotePermis(appliquer(urlHote, u, []));
    if (reseauSeul) return false;
    if (schema === "data:" || schema === "blob:" || schema === "about:") return true;
    if (schema === "chrome-extension:") return !!idExtension && appliquer(urlHote, u, []) === idExtension;
    return false;
  };
  /** Chaque morceau d'un `srcset` / `ping` (coupé aux espaces et aux virgules : plus strict que le navigateur). */
  const listePermise = (valeur) => {
    const morceaux = appliquer(decouper, valeur, [/[\s,]+/]);
    for (let i = 0; i < morceaux.length; i++) if (morceaux[i] && !permise(morceaux[i], false)) return false;
    return true;
  };
  const ATTRIBUTS = { __proto__: null, src: 1, href: 1, "xlink:href": 1, action: 1, formaction: 1, data: 1, poster: 1, background: 1, srcset: 2, imagesrcset: 2, ping: 2 };
  const attributPermis = (nom, valeur) => {
    const n = ATTRIBUTS[appliquer(minuscules, texte(nom), [])];
    if (!n) return true;
    return n === 2 ? listePermise(valeur) : permise(valeur, false);
  };

  // --- Mots de passe

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
    figerSur(g, "FormData", Enveloppe);
  }

  const lireCible = g.Event && lireDe(g.Event.prototype, "target");
  const chemin = g.Event && g.Event.prototype.composedPath;
  const actifDe = g.Document && lireDe(g.Document.prototype, "activeElement");
  const ombreDe = g.Element && lireDe(g.Element.prototype, "shadowRoot");
  const actifOmbre = g.ShadowRoot && lireDe(g.ShadowRoot.prototype, "activeElement");
  const FILTRES = { __proto__: null, keydown: 1, keypress: 1, keyup: 1, input: 1, beforeinput: 1, paste: 1, compositionstart: 1, compositionupdate: 1, compositionend: 1, textinput: 1, formdata: 2 };
  /** Le champ actif, à travers les racines fantômes ouvertes. */
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
  /** L'événement doit-il être caché à l'écouteur de l'agent ? */
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
    // Écouteur → { "<type>|<capture>": enveloppe } : la même enveloppe pour le même triplet (retrait, doublons).
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
    // Les gestionnaires `on…` : l'agent relit la fonction qu'il a posée, la page reçoit l'enveloppe.
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
    }
  }

  // --- Réseau

  const refusee = () => new Erreur(URL_REFUSEE);
  const reqUrl = g.Request && lireDe(g.Request.prototype, "url");
  const fetchNatif = typeof g.fetch === "function" ? g.fetch : null;
  if (fetchNatif && P) {
    figerSur(g, "fetch", function fetch(entree, init) {
      let u = null;
      if (reqUrl && entree !== null && typeof entree === "object") {
        try {
          u = appliquer(reqUrl, entree, []);
        } catch {
          u = null;
        }
      }
      // Pas une requête : l'adresse est lue une fois, et c'est elle qui part.
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
  }
  /** Remplace un constructeur (`WebSocket`, `EventSource`) : l'adresse (premier argument) est vérifiée d'abord. */
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
    figerSur(g, nom, Enveloppe);
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
  const dOuvrir = descripteur(g, "open") || (g.Window && descripteur(g.Window.prototype, "open"));
  const ouvrirFenetre = dOuvrir && typeof dOuvrir.value === "function" ? dOuvrir.value : null;
  if (ouvrirFenetre) {
    // Une fenêtre vide pourrait ensuite être menée ailleurs (sa `location` est écrivable d'une autre origine) : refusée.
    figerSur(g, "open", function open(url, ...reste) {
      const u = url === undefined ? "" : texte(url);
      if (!permise(u === "" ? "about:blank" : u, true)) return null;
      return appliquer(ouvrirFenetre, this, [u, ...reste]);
    });
  }
  /** Les setters d'adresse d'une classe d'éléments. */
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
    definir(Attr.prototype, "value", {
      __proto__: null,
      get: dValeur.get,
      set: function (v) {
        const s = texte(v);
        if (!attributPermis(appliquer(nomAttr, this, []), s)) throw refusee();
        return appliquer(ecrire, this, [s]);
      },
      enumerable: dValeur.enumerable,
      configurable: false,
    });
  }
  demander();
})();
