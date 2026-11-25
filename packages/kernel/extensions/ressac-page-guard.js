// Ressac: guard of the agent's scripts in a page (passwords, network). Born for the agent's extensions (removed in
// 0.1.27); it now guards the tweaks of site apps: chrome/agent/site-actor.ts runs it first, alone, in the tweaks'
// sandbox, then `ressac-scope.js` (the granted scope), then the agent's scripts in the same sandbox.
// shortcut: the marker relay below (`ressac-files/<n>.js`, `chrome.runtime.sendMessage({ ressac: "context" })`) only
// served the extensions and is inert in that sandbox (no `chrome.runtime`); delete it with its tests when this file
// is next reworked.
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
// What really protects is the whole: this guard, the site app's grant and its network rules, never in an invisible read
// (neither the agent's JS nor CSS is injected there).
//
// The agent's script then runs in the same world and can modify the base objects: everything the guard
// uses is captured at load, calls go through `Reflect.apply`, loops are indexed (no `split`, which
// consults `Symbol.split`), the replaced properties can be neither rewritten nor deleted, and the descriptors have
// no prototype.
(() => {
  const g = globalThis;
  const descriptor = Object.getOwnPropertyDescriptor;
  // Already set in this world (another entry, executeScript): own property, which a named element of the page does not make.
  if (descriptor(g, "__ressacFile")) return;
  const apply_ = Reflect.apply;
  const build = Reflect.construct;
  const define = Object.defineProperty;
  const create_ = Object.create;
  const isList = Array.isArray;
  const Err = Error;
  const TypeErr = TypeError;
  const P = typeof Promise === "function" ? Promise : null;
  const timer = typeof g.setTimeout === "function" ? g.setTimeout : null;
  const logError = g.console && typeof g.console.error === "function" ? g.console.error : null;
  const WM = typeof WeakMap === "function" ? WeakMap : null;
  const wmGet = WM && WM.prototype.get;
  const wmSet = WM && WM.prototype.set;
  const Url = typeof URL === "function" ? URL : null;
  const readOf = (proto, name) => {
    const d = proto && descriptor(proto, name);
    return d && typeof d.get === "function" ? d.get : null;
  };
  const urlProtocol = Url && readOf(Url.prototype, "protocol");
  const urlHost = Url && readOf(Url.prototype, "hostname");
  const lowercase = String.prototype.toLowerCase;
  const fin = String.prototype.endsWith;
  const start = String.prototype.startsWith;
  const slice_ = String.prototype.slice;
  const index_ = String.prototype.indexOf;
  const text = (v) => `${v}`;

  const URL_REFUSED = "URL refusée par Ressac";

  // --- Scope and context

  let portee = null;
  const freezeOn = (obj, name, value_) => {
    try {
      define(obj, name, { __proto__: null, value: value_, writable: false, configurable: false, enumerable: false });
      return true;
    } catch (e) {
      if (logError) apply_(logError, g.console, [`[ressac] garde de page non posée sur ${name} :`, e]);
      return false;
    }
  };
  // Firefox: a content script's global is a sandbox; its `window` (also `self`, `document.defaultView`) is the page's
  // window seen through an Xray, whose own members (`open`, `fetch`, `FormData`, the `on…` handlers…) are the page's.
  // Every member guarded on the global goes through `surGlobal`, which guards it on that window too.
  const win = g.window && g.window !== g ? g.window : null;
  const onGlobal = (name, value_) => {
    freezeOn(g, name, value_);
    if (win) freezeOn(win, name, value_);
  };
  /** List of strings, copied (read once, own properties). */
  const strings = (v) => {
    const r = [];
    if (!isList(v)) return r;
    const d = descriptor(v, "length");
    const n = d && typeof d.value === "number" ? d.value : 0;
    for (let i = 0; i < n && i < 1000; i++) {
      const e = descriptor(v, `${i}`);
      if (e && typeof e.value === "string") r[r.length] = apply_(lowercase, e.value, []);
    }
    return r;
  };
  freezeOn(g, "__ressacScope", (p) => {
    if (portee !== null || p === null || typeof p !== "object") return;
    const network = descriptor(p, "network");
    const hosts = descriptor(p, "hosts");
    portee = { __proto__: null, network: strings(network && network.value), hosts: strings(hosts && hosts.value) };
  });
  const c = g.chrome;
  const runtime = c && c.runtime;
  const send = runtime && typeof runtime.sendMessage === "function" ? runtime.sendMessage : null;
  const extensionId = runtime && typeof runtime.id === "string" ? runtime.id : "";
  /** The message of `chrome.runtime.lastError` during the callback (read as an own property), or null. */
  const lastErr = () => {
    const d = runtime ? descriptor(runtime, "lastError") : undefined;
    const e = d && "value" in d ? d.value : d && typeof d.get === "function" ? apply_(d.get, runtime, []) : undefined;
    if (e === undefined || e === null) return null;
    const m = typeof e === "object" ? descriptor(e, "message") : undefined;
    return m && typeof m.value === "string" ? m.value : "erreur inconnue";
  };

  // The markers (`ressac-files/<n>.js`) deposit the index of each agent file; once the task is done, the
  // guard asks the background to inject them. The requests go one after the other (the order of the files is kept).
  const toAsk = [];
  let planned = false;
  let pending = false;
  const MAX_ATTEMPTS = 20;
  const nextOne = () => {
    if (pending || toAsk.length === 0) return;
    if (!send) {
      if (logError) apply_(logError, g.console, ["[ressac] scripts de l'agent non lancés : chrome.runtime.sendMessage absent"]);
      toAsk.length = 0;
      return;
    }
    pending = true;
    const lot = [];
    for (let i = 0; i < toAsk.length; i++) lot[lot.length] = toAsk[i];
    toAsk.length = 0;
    let attempts = 0;
    const finish = () => {
      pending = false;
      nextOne();
    };
    const attempt = () => {
      attempts++;
      const rethrow = (reason) => {
        if (attempts < MAX_ATTEMPTS && timer) {
          apply_(timer, g, [attempt, 250]);
          return;
        }
        if (logError) apply_(logError, g.console, [`[ressac] scripts de l'agent non lancés après ${attempts} essais : ${reason}`]);
        finish();
      };
      try {
        apply_(send, runtime, [
          { __proto__: null, ressac: "context", files: lot },
          (r) => {
            // Read during the callback: otherwise Chromium writes "Unchecked runtime.lastError".
            const err = lastErr();
            const d = r !== null && typeof r === "object" ? descriptor(r, "tab") : undefined;
            if (d && "value" in d) return finish();
            rethrow(err || "pas de réponse du fond");
          },
        ]);
      } catch (e) {
        rethrow(`${e && e.message}`);
      }
    };
    attempt();
  };
  freezeOn(g, "__ressacFile", (n) => {
    if (typeof n !== "number") return;
    toAsk[toAsk.length] = n;
    if (planned) return;
    planned = true;
    const leave = () => {
      planned = false;
      nextOne();
    };
    if (timer) apply_(timer, g, [leave, 0]);
    else leave();
  });

  // --- Addresses

  // The document's origin, read now (`origin` can be replaced in this world, `location` cannot).
  let pageHost = "";
  try {
    pageHost = apply_(lowercase, text(g.location.hostname), []);
  } catch {
    pageHost = "";
  }
  const docBase = g.Node && readOf(g.Node.prototype, "baseURI");
  const document = g.document;
  /** The host of a Chrome pattern (`<all_urls>`: "*", `https://*.x.test/*`: "*.x.test"), or null. */
  const patternHost = (m) => {
    if (m === "<all_urls>") return "*";
    const i = apply_(index_, m, ["://"]);
    if (i < 0) return null;
    const schema = apply_(slice_, m, [0, i]);
    if (schema !== "*" && schema !== "http" && schema !== "https" && schema !== "ws" && schema !== "wss") return null;
    const rest = apply_(slice_, m, [i + 3]);
    const j = apply_(index_, rest, ["/"]);
    let host = j < 0 ? rest : apply_(slice_, rest, [0, j]);
    const k = apply_(index_, host, [":"]);
    if (k >= 0) host = apply_(slice_, host, [0, k]);
    return host;
  };
  const hostAllowed_ = (host) => {
    if (!host) return false;
    if (host === pageHost) return true;
    if (!portee) return false;
    for (let i = 0; i < portee.network.length; i++) if (portee.network[i] === host) return true;
    for (let i = 0; i < portee.hosts.length; i++) {
      const h = patternHost(portee.hosts[i]);
      if (h === null) continue;
      if (h === "*" || h === host) return true;
      if (apply_(start, h, ["*."])) {
        const root = apply_(slice_, h, [2]);
        if (host === root || apply_(fin, host, [`.${root}`])) return true;
      }
    }
    return false;
  };
  /**
   * Is the address (relative: to the document) allowed? `reseau`: only http(s)/ws(s) to an allowed host
   * (window.open); otherwise `data:`, `blob:`, `about:` and the extension itself pass too.
   */
  const allowedUrl = (raw, networkOnly) => {
    if (!Url || !urlProtocol || !urlHost) return false;
    let u;
    try {
      const base = docBase && document ? apply_(docBase, document, []) : undefined;
      u = base === undefined ? new Url(raw) : new Url(raw, base);
    } catch {
      // Unreadable: nothing will go to it (neither fetch nor element will resolve it any better).
      return true;
    }
    const schema = apply_(urlProtocol, u, []);
    if (schema === "http:" || schema === "https:" || schema === "ws:" || schema === "wss:") return hostAllowed_(apply_(urlHost, u, []));
    if (networkOnly) return false;
    if (schema === "data:" || schema === "blob:" || schema === "about:") return true;
    if (schema === "chrome-extension:") return !!extensionId && apply_(urlHost, u, []) === extensionId;
    return false;
  };
  /**
   * Each piece of a `srcset` / `ping`, cut at whitespace and commas (stricter than the browser). Walked
   * character by character: `split` would consult `Symbol.split`, which the agent's script can set.
   */
  const SEPARATORS = { __proto__: null, " ": 1, "\t": 1, "\n": 1, "\r": 1, "\f": 1, ",": 1 };
  const allowedList = (value_) => {
    const n = value_.length;
    let departure = 0;
    for (let i = 0; i <= n; i++) {
      if (i < n && !SEPARATORS[value_[i]]) continue;
      if (i > departure && !allowedUrl(apply_(slice_, value_, [departure, i]), false)) return false;
      departure = i + 1;
    }
    return true;
  };
  const ATTRIBUTES = { __proto__: null, src: 1, href: 1, "xlink:href": 1, action: 1, formaction: 1, data: 1, poster: 1, background: 1, srcset: 2, imagesrcset: 2, ping: 2 };
  const attributeAllowed = (name, value_) => {
    const n = ATTRIBUTES[apply_(lowercase, text(name), [])];
    if (!n) return true;
    return n === 2 ? allowedList(value_) : allowedUrl(value_, false);
  };

  // --- Passwords

  const HIE = g.HTMLInputElement;
  const typeOf_ = HIE && readOf(HIE.prototype, "type");
  const isPassword = (n) => {
    if (!typeOf_ || n === null || typeof n !== "object") return false;
    try {
      return apply_(typeOf_, n, []) === "password";
    } catch {
      return false;
    }
  };
  if (HIE && typeOf_) {
    const d = descriptor(HIE.prototype, "value");
    if (d && typeof d.get === "function") {
      const read = d.get;
      define(HIE.prototype, "value", {
        __proto__: null,
        get: function () {
          const v = apply_(read, this, []);
          return isPassword(this) ? "" : v;
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
  const attributeName = AttrP && readOf(AttrP, "name");
  const attrOwner = AttrP && readOf(AttrP, "ownerElement");
  const isValue = (name) => typeof name === "string" && apply_(lowercase, name, []) === "value";
  /** True if `a` is the `value` attribute of a password field (false for anything that is not an `Attr`). */
  const attrHidden = (a) => {
    if (!attributeName || !attrOwner || a === null || typeof a !== "object") return false;
    try {
      return isValue(apply_(attributeName, a, [])) && isPassword(apply_(attrOwner, a, []));
    } catch {
      return false;
    }
  };
  const hideGetter = (proto, name, hidden) => {
    const d = proto && descriptor(proto, name);
    if (!d || typeof d.get !== "function") return;
    const read = d.get;
    try {
      define(proto, name, {
        __proto__: null,
        get: function () {
          const v = apply_(read, this, []);
          return hidden(this) ? "" : v;
        },
        set: d.set,
        enumerable: d.enumerable,
        configurable: false,
      });
    } catch (e) {
      if (logError) apply_(logError, g.console, [`[ressac] garde de page non posée sur ${name} :`, e]);
    }
  };
  if (HIE && typeOf_) hideGetter(HIE.prototype, "defaultValue", isPassword);
  if (g.Node) {
    hideGetter(g.Node.prototype, "nodeValue", attrHidden);
    hideGetter(g.Node.prototype, "textContent", attrHidden);
  }
  const ElP = g.Element && g.Element.prototype;
  if (ElP && typeOf_) {
    const readAttr = ElP.getAttribute;
    const readAttrNS = ElP.getAttributeNS;
    if (typeof readAttr === "function") {
      freezeOn(ElP, "getAttribute", function getAttribute(name) {
        // The name is converted only once: an object whose `toString` changes does not pass between the two reads.
        const n = text(name);
        const v = apply_(readAttr, this, [n]);
        return v !== null && isPassword(this) && isValue(n) ? "" : v;
      });
    }
    if (typeof readAttrNS === "function") {
      freezeOn(ElP, "getAttributeNS", function getAttributeNS(ns, name) {
        const n = text(name);
        const v = apply_(readAttrNS, this, [ns, n]);
        return v !== null && isPassword(this) && isValue(n) ? "" : v;
      });
    }
  }

  const FD = g.FormData;
  const HFE = g.HTMLFormElement;
  const elementsOf = HFE && readOf(HFE.prototype, "elements");
  const collectionLength = g.HTMLCollection && readOf(g.HTMLCollection.prototype, "length");
  const nameOf = HIE && readOf(HIE.prototype, "name");
  const removeFD = FD && FD.prototype.delete;
  if (FD && elementsOf && collectionLength && nameOf && typeof removeFD === "function") {
    const Wrapper = function FormData(...a) {
      if (new.target === undefined) throw new TypeErr("Failed to construct 'FormData': Please use the 'new' operator.");
      const fd = build(FD, a, new.target);
      if (a.length > 0 && a[0] !== undefined) {
        const els = apply_(elementsOf, a[0], []);
        const n = apply_(collectionLength, els, []);
        for (let i = 0; i < n; i++) {
          const el = els[i];
          if (!isPassword(el)) continue;
          const name = apply_(nameOf, el, []);
          if (name) apply_(removeFD, fd, [name]);
        }
      }
      return fd;
    };
    define(Wrapper, "prototype", { __proto__: null, value: FD.prototype, writable: false, configurable: false, enumerable: false });
    freezeOn(FD.prototype, "constructor", Wrapper);
    onGlobal("FormData", Wrapper);
  }

  const readTarget = g.Event && readOf(g.Event.prototype, "target");
  const path = g.Event && g.Event.prototype.composedPath;
  const activeOf = g.Document && readOf(g.Document.prototype, "activeElement");
  const shadowOf = g.Element && readOf(g.Element.prototype, "shadowRoot");
  const activeInShadow = g.ShadowRoot && readOf(g.ShadowRoot.prototype, "activeElement");
  const FILTERS = { __proto__: null, keydown: 1, keypress: 1, keyup: 1, input: 1, beforeinput: 1, paste: 1, compositionstart: 1, compositionupdate: 1, compositionend: 1, textinput: 1, formdata: 2 };
  /** The active field, through the open shadow roots. */
  const deepActive = () => {
    if (!activeOf || !document) return null;
    let a = apply_(activeOf, document, []);
    for (let i = 0; i < 32 && a; i++) {
      const r = shadowOf ? apply_(shadowOf, a, []) : null;
      const b = r && activeInShadow ? apply_(activeInShadow, r, []) : null;
      if (!b) break;
      a = b;
    }
    return a;
  };
  /** Must the event be hidden from the agent's listener? */
  const cache = (type, e) => {
    const f = FILTERS[type];
    if (!f) return false;
    if (f === 2) return true;
    try {
      if (readTarget && isPassword(apply_(readTarget, e, []))) return true;
      const p = path ? apply_(path, e, []) : null;
      if (p && p.length > 0 && isPassword(p[0])) return true;
      return isPassword(deepActive());
    } catch {
      return true;
    }
  };
  const typeName = (t) => apply_(lowercase, text(t), []);
  const wrapListener = (type, l) =>
    function (e) {
      if (cache(type, e)) return undefined;
      if (typeof l === "function") return apply_(l, this, [e]);
      const h = l && l.handleEvent;
      return typeof h === "function" ? apply_(h, l, [e]) : undefined;
    };

  const ET = g.EventTarget;
  if (ET && WM) {
    const add = ET.prototype.addEventListener;
    const remove = ET.prototype.removeEventListener;
    // Listener → { "<type>|<capture>": wrapper }: the same wrapper for the same triplet (removal, duplicates).
    const wrappers = new WM();
    const wrapperOf = (type, l, options, createIfMissing) => {
      if (l === null || (typeof l !== "object" && typeof l !== "function")) return null;
      let capture = false;
      if (typeof options === "boolean") capture = options;
      else if (options !== null && typeof options === "object") capture = !!options.capture;
      const key = `${type}|${capture}`;
      let table = apply_(wmGet, wrappers, [l]);
      if (!table) {
        if (!createIfMissing) return null;
        table = create_(null);
        apply_(wmSet, wrappers, [l, table]);
      }
      if (!table[key] && createIfMissing) table[key] = wrapListener(type, l);
      return table[key] || null;
    };
    if (typeof add === "function" && typeof remove === "function") {
      freezeOn(ET.prototype, "addEventListener", function addEventListener(type, l, options) {
        const t = text(type);
        if (!FILTERS[typeName(t)]) return apply_(add, this, [t, l, options]);
        const w = wrapperOf(typeName(t), l, options, true);
        return apply_(add, this, [t, w || l, options]);
      });
      freezeOn(ET.prototype, "removeEventListener", function removeEventListener(type, l, options) {
        const t = text(type);
        if (!FILTERS[typeName(t)]) return apply_(remove, this, [t, l, options]);
        const w = wrapperOf(typeName(t), l, options, false);
        return apply_(remove, this, [t, w || l, options]);
      });
    }
    // The `on…` handlers: the agent reads back the function it set, the page receives the wrapper.
    const placed = new WM();
    const ON_NAMES = ["onkeydown", "onkeypress", "onkeyup", "oninput", "onbeforeinput", "onpaste", "onformdata"];
    const protos = [g.HTMLElement, g.SVGElement, g.MathMLElement, g.Document, g.Window];
    const onProto = (o, name) => {
      const d = o && descriptor(o, name);
      if (!d || typeof d.set !== "function" || typeof d.get !== "function") return;
      const read = d.get;
      const write = d.set;
      const type = apply_(slice_, name, [2]);
      define(o, name, {
        __proto__: null,
        get: function () {
          const v = apply_(read, this, []);
          const table = apply_(wmGet, placed, [this]);
          return table && table[name] && table[name].wrapper === v ? table[name].fn : v;
        },
        set: function (f) {
          if (typeof f !== "function") return apply_(write, this, [f]);
          const w = wrapListener(type, f);
          let table = apply_(wmGet, placed, [this]);
          if (!table) {
            table = create_(null);
            apply_(wmSet, placed, [this, table]);
          }
          table[name] = { __proto__: null, fn: f, wrapper: w };
          return apply_(write, this, [w]);
        },
        enumerable: d.enumerable,
        configurable: false,
      });
    };
    for (let i = 0; i < ON_NAMES.length; i++) {
      for (let j = 0; j < protos.length; j++) onProto(protos[j] && protos[j].prototype, ON_NAMES[i]);
      onProto(g, ON_NAMES[i]);
      if (win) onProto(win, ON_NAMES[i]);
    }
  }

  // --- Network

  const refused = () => new Err(URL_REFUSED);
  const reqUrl = g.Request && readOf(g.Request.prototype, "url");
  const nativeFetch = typeof g.fetch === "function" ? g.fetch : null;
  if (nativeFetch && P) {
    onGlobal("fetch", function fetch(entry, init) {
      let u = null;
      if (reqUrl && entry !== null && typeof entry === "object") {
        try {
          u = apply_(reqUrl, entry, []);
        } catch {
          u = null;
        }
      }
      // Not a request: the address is read once, and that is the one that goes.
      const target_ = u === null ? text(entry) : entry;
      if (!allowedUrl(u === null ? target_ : u, false)) return new P((_ok, ko) => ko(new TypeErr(URL_REFUSED)));
      return apply_(nativeFetch, g, arguments.length > 1 ? [target_, init] : [target_]);
    });
  }
  const XHR = g.XMLHttpRequest;
  if (XHR && typeof XHR.prototype.open === "function") {
    const open_ = XHR.prototype.open;
    freezeOn(XHR.prototype, "open", function open(method, url, ...rest) {
      const u = text(url);
      if (!allowedUrl(u, false)) throw refused();
      return apply_(open_, this, [method, u, ...rest]);
    });
    // Firefox: the sandbox's own XMLHttpRequest (guarded prototype) replaces the page's on the Xray window.
    if (win && win.XMLHttpRequest !== XHR) freezeOn(win, "XMLHttpRequest", XHR);
  }
  /** Replaces a constructor (`WebSocket`, `EventSource`): the address (first argument) is checked first. */
  const guardConstructor = (name) => {
    const C = g[name];
    if (typeof C !== "function") return;
    const Wrapper = function (url, ...rest) {
      if (new.target === undefined) throw new TypeErr(`Failed to construct '${name}': Please use the 'new' operator.`);
      const u = text(url);
      if (!allowedUrl(u, false)) throw refused();
      return build(C, [u, ...rest], new.target);
    };
    define(Wrapper, "name", { __proto__: null, value: name });
    define(Wrapper, "prototype", { __proto__: null, value: C.prototype, writable: false, configurable: false, enumerable: false });
    const constants = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    for (let i = 0; i < constants.length; i++) {
      const d = descriptor(C, constants[i]);
      if (d) define(Wrapper, constants[i], { __proto__: null, value: d.value, enumerable: true });
    }
    freezeOn(C.prototype, "constructor", Wrapper);
    onGlobal(name, Wrapper);
  };
  guardConstructor("WebSocket");
  guardConstructor("EventSource");
  const Nav = g.Navigator;
  if (Nav && typeof Nav.prototype.sendBeacon === "function") {
    const tag = Nav.prototype.sendBeacon;
    freezeOn(Nav.prototype, "sendBeacon", function sendBeacon(url, ...rest) {
      const u = text(url);
      if (!allowedUrl(u, false)) return false;
      return apply_(tag, this, [u, ...rest]);
    });
  }
  const ofOpen = descriptor(g, "open") || (win && descriptor(win, "open")) || (g.Window && descriptor(g.Window.prototype, "open"));
  const openWindow = ofOpen && typeof ofOpen.value === "function" ? ofOpen.value : null;
  if (openWindow) {
    // An empty window could then be led elsewhere (its `location` is writable from another origin): refused.
    const open = function open(url, ...rest) {
      const u = url === undefined ? "" : text(url);
      if (!allowedUrl(u === "" ? "about:blank" : u, true)) return null;
      return apply_(openWindow, this === g ? win || g : this, [u, ...rest]);
    };
    onGlobal("open", open);
  }
  /** The address setters of an element class. */
  const guardSetters = (klass, names) => {
    const C = g[klass];
    const proto = C && C.prototype;
    if (!proto) return;
    for (let i = 0; i < names.length; i++) {
      const d = descriptor(proto, names[i]);
      if (!d || typeof d.set !== "function") continue;
      const write = d.set;
      const name = names[i];
      const list = name === "srcset" || name === "imageSrcset" || name === "ping";
      define(proto, name, {
        __proto__: null,
        get: d.get,
        set: function (v) {
          const s = text(v);
          if (!(list ? allowedList(s) : allowedUrl(s, false))) throw refused();
          return apply_(write, this, [s]);
        },
        enumerable: d.enumerable,
        configurable: false,
      });
    }
  };
  guardSetters("HTMLImageElement", ["src", "srcset"]);
  guardSetters("HTMLSourceElement", ["src", "srcset"]);
  guardSetters("HTMLScriptElement", ["src"]);
  guardSetters("HTMLIFrameElement", ["src"]);
  guardSetters("HTMLFrameElement", ["src"]);
  guardSetters("HTMLEmbedElement", ["src"]);
  guardSetters("HTMLMediaElement", ["src"]);
  guardSetters("HTMLTrackElement", ["src"]);
  guardSetters("HTMLVideoElement", ["poster"]);
  guardSetters("HTMLInputElement", ["src", "formAction"]);
  guardSetters("HTMLButtonElement", ["formAction"]);
  guardSetters("HTMLFormElement", ["action"]);
  guardSetters("HTMLAnchorElement", ["href", "ping"]);
  guardSetters("HTMLAreaElement", ["href", "ping"]);
  guardSetters("HTMLLinkElement", ["href", "imageSrcset"]);
  guardSetters("HTMLBaseElement", ["href"]);
  guardSetters("HTMLObjectElement", ["data"]);
  const El = g.Element;
  if (El) {
    const setAttr = El.prototype.setAttribute;
    const setAttrNS = El.prototype.setAttributeNS;
    if (typeof setAttr === "function") {
      freezeOn(El.prototype, "setAttribute", function setAttribute(name, value_) {
        const n = text(name);
        const v = text(value_);
        if (!attributeAllowed(n, v)) throw refused();
        return apply_(setAttr, this, [n, v]);
      });
    }
    if (typeof setAttrNS === "function") {
      freezeOn(El.prototype, "setAttributeNS", function setAttributeNS(ns, name, value_) {
        const n = text(name);
        const v = text(value_);
        const k = apply_(index_, n, [":"]);
        if (!attributeAllowed(n, v) || !attributeAllowed(k < 0 ? n : apply_(slice_, n, [k + 1]), v)) throw refused();
        return apply_(setAttrNS, this, [ns, n, v]);
      });
    }
  }
  const Attr = g.Attr;
  const ofValue = Attr && descriptor(Attr.prototype, "value");
  const attrName = Attr && readOf(Attr.prototype, "name");
  if (ofValue && typeof ofValue.set === "function" && attrName) {
    const write = ofValue.set;
    const readValue = ofValue.get;
    define(Attr.prototype, "value", {
      __proto__: null,
      // Passwords: the `value` attribute of a password field reads empty (see above).
      get:
        typeof readValue === "function"
          ? function () {
              const v = apply_(readValue, this, []);
              return attrHidden(this) ? "" : v;
            }
          : readValue,
      set: function (v) {
        const s = text(v);
        if (!attributeAllowed(apply_(attrName, this, []), s)) throw refused();
        return apply_(write, this, [s]);
      },
      enumerable: ofValue.enumerable,
      configurable: false,
    });
  }
})();
