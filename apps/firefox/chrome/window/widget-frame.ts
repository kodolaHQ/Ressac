import { NETWORK_HINTS_PATTERN, containsNetworkHint } from "../../shared/network-hints";

/**
 * The widgets' CSP: a resource:// file cannot carry a response header, so the CSP is
 * injected as a `<meta http-equiv>` into the copy the sidebar writes.
 */
export const CSP_WIDGET =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types default";
/** Served in place of a display that contains a network hint. */
export const DISPLAY_DENIED =
  '<!doctype html><meta charset="utf-8"><p style="font: 13px system-ui; color-scheme: light dark; color: light-dark(#c9473e, #e5736b)">Affichage refusé : il contient &lt;link&gt;, &lt;meta http-equiv&gt; ou des règles de spéculation, qui feraient sortir des données. Voir AGENTS.md.</p>';

const ID_WIDGET = /^[a-z0-9-]+$/;
const PREFIX = "webaios-widget-";

/** The name of a widget's resource:// substitution: `webaios-widget-<id>`. */
function substitutionName(id: string): string {
  return `${PREFIX}${id}`;
}

/** The frame's URL: the sanitized copy, dated with the source's mtime (a new mtime reloads the frame). */
export function displayUrl(id: string, mtime: number): string {
  return `resource://${PREFIX}${id}/display-${mtime}.html`;
}

/** The folder of a widget's copies: `<dataDir>/webaios-widgets/<id>/`. */
function copiesFolder(dataDir: string, id: string): string {
  return PathUtils.join(dataDir, "webaios-widgets", id);
}

/**
 * The copies folder, created then confined to `<dataDir>/webaios-widgets`: a copies folder that is a symbolic
 * link is refused. Returns its real path, where the copies are written.
 */
async function confinedCopiesFolder(dataDir: string, id: string): Promise<string | null> {
  const folder = copiesFolder(dataDir, id);
  await IOUtils.makeDirectory(folder, { createAncestors: true, ignoreExisting: true });
  const root = realPath(PathUtils.join(dataDir, "webaios-widgets"));
  const real = realPath(folder);
  return root && real && real.startsWith(root + "/") ? real : null;
}

/** The sanitized copy of a display: `<copiesFolder>/display-<mtime>.html`. */
export function copyPath(dataDir: string, id: string, mtime: number): string {
  return PathUtils.join(copiesFolder(dataDir, id), `display-${mtime}.html`);
}

/**
 * `realpath`, synchronous (`nsIFile.normalize`). The agent writes in the widgets' folders: a symbolic link must not
 * show a Mac file there.
 */
function realPath(path: string): string | null {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    file.normalize();
    return file.path;
  } catch {
    return null;
  }
}

/** The real path of `<dataDir>/workspace/home/widgets/<id>/display.html`, confined to the widget's folder. */
function sourcePath(dataDir: string, id: string): string | null {
  if (!ID_WIDGET.test(id)) return null;
  const widgetsDir = PathUtils.join(dataDir, "workspace", "home", "widgets");
  const folder = PathUtils.join(widgetsDir, id);
  const root = realPath(widgetsDir);
  const realFolder = realPath(folder);
  const realFile = realPath(PathUtils.join(folder, "display.html"));
  if (!root || !realFolder || !realFile) return null;
  return realFolder.startsWith(root + "/") && realFile.startsWith(realFolder + "/") ? realFile : null;
}

/**
 * The widget guard, run in the page world from the served copy before the widget's own scripts. No
 * `JSWindowActor`: measured, the actor's child never installs on these `resource://` frames in this Firefox. Self-contained
 * (no imports, no `win`: it uses the page's `window`), serialized with `toString()`, the network-hint pattern passed as
 * its argument. The WebRTC globals go last: if an earlier step throws, `RTCPeerConnection` is still there, and the UI
 * (which only attaches its gesture listener when it is gone) records no click — the guard fails closed.
 */
function widgetGuard(pattern: string): void {
  const w = window as unknown as Record<string, any>;
  const deny = (what: string): never => {
    throw new TypeError(`Refusé dans l'affichage d'un widget : ${what}`);
  };
  const hint = new RegExp(pattern, "i");
  const containsHint = (html: string) => {
    let before: string;
    let x = html;
    do {
      before = x;
      x = x.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos));?/gi, (_m, dec?: string, hex?: string, name?: string) => {
        if (name) return ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()]!;
        const n = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : String.fromCharCode(0xfffd);
      });
    } while (x !== before);
    return hint.test(x);
  };
  // No catch: a policy that cannot be created fails the whole guard, and no link then opens.
  w.trustedTypes?.createPolicy("default", {
    createHTML: (html: string) => (containsHint(String(html)) ? deny("<link>, <meta http-equiv> ou règles de spéculation") : html),
    createScript: () => deny("code en texte (URL javascript:, gestionnaire en attribut, texte d'un script)"),
    createScriptURL: () => deny("script externe"),
  });
  const tags = ["link", "meta"];
  const localName = (n: unknown) => String(n).toLowerCase().split(":").pop() ?? "";
  const D = w.Document.prototype;
  const create = D.createElement;
  const createNS = D.createElementNS;
  const replace = (proto: any, name: string, f: (...a: any[]) => unknown) => {
    Object.defineProperty(proto, name, { configurable: true, writable: true, value: f });
  };
  replace(D, "createElement", function (this: unknown, name: unknown, o?: unknown) {
    if (tags.includes(localName(name))) return deny(`<${String(name)}>`);
    return create.call(this, name, o);
  });
  replace(D, "createElementNS", function (this: unknown, ns: unknown, name: unknown, o?: unknown) {
    if (tags.includes(localName(name))) return deny(`<${String(name)}>`);
    return createNS.call(this, ns, name, o);
  });
  // Structural rule, whatever the path (createDocument then adoptNode, DOMParser, template, cloneNode…): no <link>
  // nor <meta>, alone or inside a fragment, enters a document. The accessors are taken now, before the widget.
  const selector = tags.join(",");
  const forbiddenIn = (n: any): boolean => {
    if (!n || typeof n !== "object") return false;
    let t: number;
    try {
      t = n.nodeType;
    } catch {
      return false; // not a node (text given to append): nothing to check
    }
    if (t === 1) return tags.includes(String(n.localName).toLowerCase()) || n.querySelector(selector) !== null;
    if (t === 11) return n.querySelector(selector) !== null;
    return false;
  };
  const keep = (proto: any, names: string[]) => {
    if (!proto) return;
    for (const name of names) {
      const f = proto[name];
      if (typeof f !== "function") continue;
      replace(proto, name, function (this: unknown, ...a: unknown[]) {
        if (a.some(forbiddenIn)) return deny("<link> ou <meta> inséré dans la page");
        return f.apply(this, a);
      });
    }
  };
  keep(w.Node.prototype, ["appendChild", "insertBefore", "replaceChild"]);
  const children = ["append", "prepend", "replaceChildren"];
  const neighbors = ["before", "after", "replaceWith"];
  keep(w.Element.prototype, [...children, ...neighbors, "insertAdjacentElement"]);
  keep(D, children);
  keep(w.DocumentFragment.prototype, children);
  keep(w.CharacterData?.prototype, neighbors);
  keep(w.DocumentType?.prototype, neighbors);
  keep(w.Range?.prototype, ["insertNode", "surroundContents"]);
  // execCommand("insertHTML") is not a Trusted Types sink.
  const command = D.execCommand;
  if (typeof command === "function")
    replace(D, "execCommand", function (this: unknown, name: unknown, ...a: unknown[]) {
      if (String(name).toLowerCase() === "inserthtml" && containsHint(String(a[1] ?? ""))) return deny("<link>, <meta http-equiv> ou règles de spéculation");
      return command.call(this, name, ...a);
    });
  const R = w.CustomElementRegistry?.prototype;
  if (R) {
    const define = R.define;
    replace(R, "define", function (this: unknown, name: unknown, cls: unknown, o?: { extends?: unknown }) {
      if (o && tags.includes(localName(o.extends))) return deny(`élément qui étend <${String(o.extends)}>`);
      return define.call(this, name, cls, o);
    });
  }
  // Firefox: a sandboxed resource frame cannot post to its chrome parent (measured: Permission denied to access
  // property "postMessage"). The widget's link goes through this page-world helper, a custom event the chrome listens for.
  w.webaiosOpen = (url: unknown) => w.dispatchEvent(new CustomEvent("webaios-open", { detail: String(url) }));
  // Last: see the comment on widgetGuard.
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
    "WebTransport",
    "XSLTProcessor",
  ];
  for (const name of absents) {
    try {
      // Own non-configurable value: the global lives on Window.prototype, so deleting it does not shadow it.
      Object.defineProperty(w, name, { value: undefined, configurable: false, writable: false });
    } catch {
      // already a non-configurable own property: nothing more to do
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
}

/** The guard's `<script>`, injected into the served copy after the CSP meta: the page parser runs it first. */
const GUARD_SCRIPT = `<script>(${widgetGuard.toString()})(${JSON.stringify(NETWORK_HINTS_PATTERN)});</script>`;

/** Whitespace, leading comments and an optional doctype: everything the guard must be inserted after. */
const DOC_PREFIX = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype[^>]*>\s*)?/i;

/**
 * The served text: the CSP meta (`csp`) then the guard, then `extra` (an app home's bridge), after any
 * doctype (the doctype stays the first token, no quirks mode) and before any other element; DISPLAY_DENIED if the
 * HTML contains a network hint.
 */
export function displayServed(html: string, csp = CSP_WIDGET, extra = ""): string {
  if (containsNetworkHint(html)) return DISPLAY_DENIED;
  const prefix = html.match(DOC_PREFIX)?.[0] ?? "";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  return `${prefix}${meta}${GUARD_SCRIPT}${extra}${html.slice(prefix.length)}`;
}

/** The widget's resource:// substitution, or `null` to remove it. */
function substitute(id: string, folder: string | null): void {
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler)
    .setSubstitution(substitutionName(id), folder ? Services.io.newFileURI(new FileUtils.File(folder)) : null);
}

/**
 * Prepares a widget's display: writes its sanitized copy if the source's mtime changed, then sets the
 * `resource://webaios-widget-<id>/` substitution. Returns the frame's URL, or null if the display is absent or leaves its
 * folder.
 */
export async function prepareWidget(dataDir: string, id: string): Promise<string | null> {
  const source = sourcePath(dataDir, id);
  if (!source) return null;
  let mtime: number;
  try {
    mtime = Math.round((await IOUtils.stat(source)).lastModified);
  } catch {
    return null;
  }
  const folder = copiesFolder(dataDir, id);
  try {
    const real = await confinedCopiesFolder(dataDir, id);
    if (!real) {
      console.warn(`[widget] copies folder of ${id} outside <dataDir>/webaios-widgets: refused`);
      return null;
    }
    const copy = PathUtils.join(real, `display-${mtime}.html`);
    // Same mtime: the copy already exists, it is not rewritten (the URL does not change).
    if (!(await IOUtils.exists(copy))) {
      // shortcut: the source is read by the realpath computed just before; a symlink swapped in by another process
      // between the check and the read is still followed (IOUtils has no O_NOFOLLOW). Upgrade if the widgets folder can
      // be written by an untrusted process.
      // Atomic write (pattern of site-permissions.ts): a frame never reads a half-written copy.
      const temp = `${copy}.${crypto.randomUUID()}.tmp`;
      await IOUtils.writeUTF8(temp, displayServed(await IOUtils.readUTF8(source)), { flush: true });
      await IOUtils.move(temp, copy);
      // A single copy per widget: the previous one is removed.
      for (const old of await IOUtils.getChildren(real)) {
        if (old !== copy && /display-.*\.html$/.test(old)) await IOUtils.remove(old, { ignoreAbsent: true });
      }
    }
    substitute(id, folder);
  } catch (e) {
    console.error(`[widget] copy of ${id} failed:`, e);
    return null;
  }
  return displayUrl(id, mtime);
}

/** The widget no longer exists: removes its substitution and its copies folder (best effort). */
export async function forgetWidget(dataDir: string, id: string): Promise<void> {
  if (!ID_WIDGET.test(id)) return;
  try {
    substitute(id, null);
  } catch {
    // nothing to remove
  }
  await IOUtils.remove(copiesFolder(dataDir, id), { recursive: true, ignoreAbsent: true }).catch(() => {});
}
