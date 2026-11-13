// Spikes S1–S3 of docs/superpowers/specs/2026-11-08-ressac-firefox-reseau-interfaces-design.md: a throwaway
// prototype of the spec's four pieces (the predicate, the content policy, the opening-request observer, the docShell
// flags, the PeerConnection:request refusal), switchable at run time so each layer is measured alone.
// Imported in the parent from resource://ressac-spike-net/ by ui-network-spike.e2e.ts. Not product code.

const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const UI_PREFIXES = ["chrome://browser/content/ressac/", "resource://ressac-widget-", "resource://ressac-component-", "resource://ressac-site-"];
const BLOCKED_SCHEMES = new Set(["http", "https", "ws", "wss"]);

/** policy: off | log | reject; observer: off | log | cancel; webrtc: off | deny. */
export const mode = { policy: "off", observer: "off", webrtc: "off" };
export const log = { policy: [], observer: [], webrtc: [] };

export const isUiAddress = (spec) => UI_PREFIXES.some((p) => String(spec).startsWith(p));

/** The spec's predicate: the document's own address, or an in-process chrome ancestor's, up to the window (excluded). */
export function isUiDocument(doc) {
  for (let d = doc, i = 0; d && i < 32; i++) {
    const bc = d.defaultView?.browsingContext;
    if (!bc || bc.isContent) return false;
    if (isUiAddress(d.documentURI)) return true;
    const el = bc.embedderElement;
    if (!el) return false;
    d = el.ownerDocument;
  }
  return false;
}

/** A UI frame is marked by its docShell's appType (cutFrameNetwork). */
export function isUiFrame(node) {
  try {
    return node?.frameLoader?.docShell?.appType === Ci.nsIDocShell.APP_TYPE_MAIL;
  } catch {
    return false;
  }
}

export function isUiLoad(li) {
  const doc = li.loadingDocument;
  const node = li.loadingNode;
  if (doc || node) return (!!doc && isUiDocument(doc)) || isUiFrame(node);
  // A frame's navigation, seen in the parent's DocumentLoadListener: no loading document nor node (measured), only the
  // target browsing context; it is the UI's if its embedder is a marked frame or sits in a UI document.
  const bc = li.browsingContext;
  if (!bc || bc.isContent) return false;
  const e = bc.embedderElement;
  return !!e && (isUiFrame(e) || isUiDocument(e.ownerDocument));
}

function innermost(uri) {
  let u = uri;
  while (u instanceof Ci.nsINestedURI) u = u.QueryInterface(Ci.nsINestedURI).innerURI;
  return u;
}

/** http(s)/ws(s) whatever the host, and moz-remote-image around anything but data:. */
export function isNetworkAddress(uri) {
  const u = innermost(uri);
  if (BLOCKED_SCHEMES.has(u.scheme)) return true;
  if (u.scheme === "moz-remote-image") {
    try {
      return !String(new URL(u.spec).searchParams.get("url") ?? "").startsWith("data:");
    } catch {
      return true;
    }
  }
  return false;
}

const principal = (p) => {
  try {
    return p ? (p.isSystemPrincipal ? "system" : p.origin) : null;
  } catch {
    return "?";
  }
};
function describe(uri, li) {
  const bc = li.browsingContext;
  const node = li.loadingNode;
  return {
    type: li.externalContentPolicyType,
    uri: String(uri.spec).slice(0, 140),
    doc: li.loadingDocument ? String(li.loadingDocument.documentURI).slice(0, 100) : null,
    node: node ? node.localName + (node.id ? "#" + node.id : "") : null,
    loading: principal(li.loadingPrincipal),
    triggering: principal(li.triggeringPrincipal),
    bc: bc ? { id: bc.id, content: bc.isContent, top: bc.top?.id ?? null } : null,
  };
}

const POLICY_CONTRACT = "@ressac/spike-ui-network-policy;1";
const policy = {
  classID: Components.ID("{3b0d8f52-6c41-4e7a-9a2f-7d5c1e8b4a93}"),
  QueryInterface: ChromeUtils.generateQI(["nsIContentPolicy", "nsIFactory"]),
  createInstance: (iid) => policy.QueryInterface(iid),
  shouldLoad(location, li) {
    if (mode.policy === "off" || !isNetworkAddress(location)) return Ci.nsIContentPolicy.ACCEPT;
    const ui = isUiLoad(li);
    if (log.policy.length < 2000) log.policy.push({ ...describe(location, li), ui, at: Date.now() });
    return ui && mode.policy === "reject" ? Ci.nsIContentPolicy.REJECT_REQUEST : Ci.nsIContentPolicy.ACCEPT;
  },
  shouldProcess: () => Ci.nsIContentPolicy.ACCEPT,
};
const observer = {
  observe(subject) {
    if (mode.observer === "off") return;
    const channel = subject.QueryInterface(Ci.nsIChannel);
    const ui = isUiLoad(channel.loadInfo);
    if (log.observer.length < 2000) log.observer.push({ ...describe(channel.URI, channel.loadInfo), ui, at: Date.now() });
    if (ui && mode.observer === "cancel" && isNetworkAddress(channel.URI)) channel.cancel(Cr.NS_BINDING_ABORTED);
  },
};
const webrtc = {
  observe(subject) {
    let doc = null;
    let ui = false;
    try {
      doc = Services.wm.getOuterWindowWithId(subject.windowID)?.document ?? null;
      ui = !!doc && isUiDocument(doc);
    } catch (e) {
      doc = { documentURI: "error " + e };
    }
    log.webrtc.push({ windowID: subject.windowID, callID: subject.callID, doc: doc ? String(doc.documentURI).slice(0, 100) : null, ui, mode: mode.webrtc, at: Date.now() });
    if (ui && mode.webrtc === "deny") Services.obs.notifyObservers(null, "PeerConnection:response:deny", subject.callID);
  },
};

let installed = false;
export function install() {
  if (installed) return;
  installed = true;
  Components.manager.QueryInterface(Ci.nsIComponentRegistrar).registerFactory(policy.classID, "spike UI network policy", POLICY_CONTRACT, policy);
  Services.catMan.addCategoryEntry("content-policy", POLICY_CONTRACT, POLICY_CONTRACT, false, true);
  Services.obs.addObserver(observer, "http-on-opening-request");
  Services.obs.addObserver(webrtc, "PeerConnection:request");
}

/** The spec's cutFrameNetwork. */
export function cut(frame) {
  const ds = frame.frameLoader?.docShell ?? frame.contentWindow.docShell;
  ds.allowDNSPrefetch = false;
  ds.appType = Ci.nsIDocShell.APP_TYPE_MAIL;
}
export function flags(frame) {
  const ds = frame.frameLoader?.docShell ?? frame.contentWindow?.docShell;
  return ds ? { allowDNSPrefetch: ds.allowDNSPrefetch, appType: ds.appType, windowDraggingAllowed: ds.windowDraggingAllowed, docAllows: frame.contentDocument?.documentURI } : null;
}

const HTML = "http://www.w3.org/1999/xhtml";
const el = (doc, name, attrs = {}) => {
  const e = doc.createElementNS(HTML, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const host = (doc) => doc.body ?? doc.documentElement;

/** S1: the five hints, under names `<tag>-<kind>.<sfx>`: the anchor and preconnect on 15369 (the TCP counter), the loads on 15368 (logged). */
export function insertHints(doc, tag, sfx) {
  const n = (k) => `${tag}-${k}.${sfx}`;
  const out = {};
  for (const [k, make] of [
    ["a", () => el(doc, "a", { href: `http://${n("a")}:15369/` })],
    ["dnsp", () => el(doc, "link", { rel: "dns-prefetch", href: `//${n("dnsp")}` })],
    ["preco", () => el(doc, "link", { rel: "preconnect", href: `http://${n("preco")}:15369` })],
    ["pref", () => el(doc, "link", { rel: "prefetch", href: `http://${n("pref")}:15368/x` })],
    ["prel", () => el(doc, "link", { rel: "preload", as: "image", href: `http://${n("prel")}:15368/x.png` })],
  ]) {
    try {
      host(doc).append(make());
      out[k] = "inserted";
    } catch (e) {
      out[k] = String(e).slice(0, 80);
    }
  }
  return out;
}

/** S2: one load of each type, to http://<tag>-<kind>.<sfx>:15368/s2/<tag>/<kind>. */
export function insertLoads(doc, tag, sfx) {
  const win = doc.defaultView;
  const u = (k, scheme = "http") => `${scheme}://${tag}-${k}.${sfx}:15368/s2/${tag}/${k}`;
  const out = {};
  const run = (k, f) => {
    try {
      f();
      out[k] = "ok";
    } catch (e) {
      out[k] = String(e).slice(0, 80);
    }
  };
  run("img", () => host(doc).append(el(doc, "img", { src: u("img") })));
  run("bg", () => host(doc).append(el(doc, "div", { style: `width:4px;height:4px;background-image:url(${u("bg")})` })));
  run("font", () => {
    const s = el(doc, "style");
    s.textContent = `@font-face { font-family: spike-${tag}; src: url(${u("font")}); } .f-${tag} { font-family: spike-${tag}; }`;
    host(doc).append(s);
    const p = el(doc, "p", { class: `f-${tag}` });
    p.textContent = "font";
    host(doc).append(p);
  });
  run("fetch", () => void win.fetch(u("fetch")).catch(() => {}));
  run("ws", () => void new win.WebSocket(u("ws", "ws")));
  run("beacon", () => void win.navigator.sendBeacon(u("beacon"), "x"));
  run("frame", () => host(doc).append(el(doc, "iframe", { src: u("frame") })));
  run("remote", () => host(doc).append(el(doc, "img", { src: `moz-remote-image://?url=${encodeURIComponent(u("remote"))}&width=16&height=16` })));
  return out;
}

/** An iframe appended to `parent` (a document's body, or an element), `before(f)` run between insertion and `src`;
 * resolved once its document is the expected one (src, about:srcdoc or the initial about:blank) and complete, or after 3 s. */
export async function addFrame(parent, attrs = {}, src = null, before = null) {
  const doc = parent.ownerDocument ?? parent;
  const f = el(doc, "iframe", attrs);
  f.style.cssText = "width:20px;height:20px;border:0";
  (parent.ownerDocument ? parent : host(doc)).append(f);
  if (before) before(f);
  if (src) f.setAttribute("src", src);
  const want = src ?? (attrs.srcdoc !== undefined ? "about:srcdoc" : "about:blank");
  for (let i = 0; i < 60; i++) {
    const d = f.contentDocument;
    if (d && d.documentURI === want && d.readyState === "complete") return f;
    await new Promise((r) => setTimeout(r, 50));
  }
  return f;
}

/** S3: the page probe's twin, for a system document (eval is refused to chrome code). */
export async function rtc(C, tag, sfx) {
  const t0 = Date.now();
  const out = { tag, type: typeof C };
  if (typeof C !== "function") return out;
  let pc;
  try {
    pc = new C({ iceServers: [{ urls: `turn:turn-${tag}.${sfx}:15369?transport=tcp`, username: "u", credential: "p" }, { urls: `stun:stun-${tag}.${sfx}:15369` }] });
    pc.createDataChannel("d");
    const offer = await Promise.race([pc.createOffer(), new Promise((_, r) => setTimeout(() => r({ name: "pending" }), 3000))]);
    out.offerMs = Date.now() - t0;
    await pc.setLocalDescription(offer);
    await new Promise((r) => {
      const t = setTimeout(r, 3000);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(t);
          r();
        }
      };
    });
    out.result = "gathered:" + pc.iceGatheringState;
    out.candidates = (pc.localDescription.sdp.match(/typ [a-z]+/g) || []).map((c) => c.slice(4));
  } catch (e) {
    out.result = e?.name ?? String(e);
    out.message = String(e?.message ?? "").slice(0, 120);
  }
  out.ms = Date.now() - t0;
  try {
    pc?.close();
  } catch {}
  return out;
}
