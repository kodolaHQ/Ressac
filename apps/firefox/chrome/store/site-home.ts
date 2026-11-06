// A site app's home screen, written by the agent in `<dataDir>/espace/sites/<id>/accueil/`: the served copy (Electron's
// webaios-site: scheme, main/sites/accueil.ts, cannot be registered here: a resource:// substitution serves a sanitized
// copy), and the site images it asks for, loaded in the app's container.
import { IMAGE_SITE_MAX } from "../../../navigateur/src/commun/sites";
import { adresseLocale } from "../../../../packages/noyau/src/workflows/acces";
import { hoteDansSite } from "../../../../packages/noyau/src/sites/adresses";
import { ID_SITE } from "../../../../packages/noyau/src/sites/schemas";
import { CSP_WIDGET, affichageServi } from "../window/widget-frame";

/** Electron's FICHIER_ACCUEIL_MAX (main/sites/accueil.ts): the largest file of a home screen. */
export const FICHIER_ACCUEIL_MAX = 2 * 1024 * 1024;
/** Copy of image-distante.ts REDIRECTIONS_IMAGE (that module imports electron's net). */
export const REDIRECTIONS_IMAGE = 3;
const DELAI_IMAGE_MS = 10_000;
const TYPE_IMAGE = /^image\/[a-z0-9.+-]+$/;
/** Electron's IMAGES_EN_MEME_TEMPS and IMAGES_EN_ATTENTE_MAX (main/sites/service.ts), per app. */
const IMAGES_AT_ONCE = 4;
const IMAGES_WAITING_MAX = 200;

const DIRECTIVES_FICHIERS = new Set(["script-src", "style-src", "img-src", "font-src"]);
/**
 * The extensions Electron serves (TYPES in main/sites/accueil.ts, drift test in site-home.test.ts): no other file is
 * copied. resource:// picks a type from the extension, so an .xhtml or .xml would be a document without the home's CSP.
 */
export const HOME_TYPES = new Set([".html", ".js", ".css", ".json", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".otf"]);
const extension = (segment: string) => (segment.lastIndexOf(".") > 0 ? segment.slice(segment.lastIndexOf(".")).toLowerCase() : "");
const substitution = (key: string) => `webaios-site-${key}`;

/**
 * Electron's cspAccueilSite, with the served copy's files at `resource://webaios-site-<key>` (`key`: see serveHome) in
 * place of `webaios-site://<id>` (drift test in site-home.test.ts).
 */
export function cspAccueilFirefox(key: string): string {
  return CSP_WIDGET.split("; ")
    .map((d) => (DIRECTIVES_FICHIERS.has(d.split(" ")[0]!) ? `${d} resource://${substitution(key)}` : d))
    .join("; ");
}

/**
 * Electron's home pages call `parent.postMessage`; from a sandboxed opaque frame Firefox refuses it towards a chrome
 * parent. Run first in the served copy (page world): `parent` (a [Replaceable] property) becomes an object whose
 * postMessage dispatches `webaios-home` on the frame's window, its detail the message as JSON, for the chrome to read.
 * Self-contained, serialized with toString().
 */
export function homeBridge(): void {
  const w = window as unknown as Record<string, any>;
  const stringify = JSON.stringify;
  const Custom = w.CustomEvent;
  const dispatch = w.dispatchEvent.bind(w);
  w.parent = Object.freeze({ postMessage: (m: unknown) => void dispatch(new Custom("webaios-home", { detail: stringify(m) })) });
}

export const HOME_BRIDGE = `<script>(${homeBridge.toString()})();</script>`;

/** A page of the home: its copy's CSP, the widgets' guard, then the bridge, after the doctype; AFFICHAGE_REFUSE on a network hint. */
export function homeServed(html: string, key: string): string {
  return affichageServi(html, cspAccueilFirefox(key), HOME_BRIDGE);
}

/** `realpath` (nsIFile.normalize), or null. */
function realPath(p: string): string | null {
  try {
    const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(p);
    f.normalize();
    return f.path;
  } catch {
    return null;
  }
}

function isLink(p: string): boolean {
  const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  f.initWithPath(p);
  return f.isSymlink();
}

const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The substitution each app's home is served under now (one per app; the previous one is removed). */
const current = new Map<string, string>();

function substitute(name: string, dir: string | null): void {
  const handler = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
  if (!dir) return handler.setSubstitution(name, null);
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  handler.setSubstitutionWithFlags(name, Services.io.newFileURI(new FileUtils.File(dir)), Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS);
}

/**
 * Copies `<dataDir>/espace/sites/<id>/accueil/` into `<dataDir>/webaios-sites/<id>/<token>/` with Electron's
 * repondreAccueilSite rules: the app folder named exactly `id` (a case-insensitive disk would find « Vidola » for
 * « vidola »), no symbolic link anywhere on a path, no hidden segment, `FICHIER_ACCUEIL_MAX` at most per file,
 * only Electron's served types (HOME_TYPES); the `.html` pages go through homeServed. Points
 * `resource://webaios-site-<id>-<token>/` straight at that folder (the previous serve's substitution and folder go) and returns its `index.html`, or null (no home page, or a refused folder).
 * The token is random at each serve: the substitution is content-accessible (ALLOW_CONTENT_ACCESS, below), so neither
 * its host nor any root above it may be guessable by a web page.
 * shortcut: files are checked by realpath then read by path (IOUtils has no O_NOFOLLOW): a link swapped in between is
 * followed; and the whole folder is copied with no file count limit. Upgrade if the agent's folder can be written by an
 * untrusted process.
 */
export function serveHome(dataDir: string, id: string): Promise<string | null> {
  // One serve at a time per app: the agent writes several files in a row, and a serve cleaning up while another copies
  // would delete the other's folder. Each waits for the previous, then publishes and removes the older copies.
  const run = (serving.get(id) ?? Promise.resolve()).then(() => serveNow(dataDir, id));
  const settled = run.catch(() => {});
  serving.set(id, settled);
  void settled.then(() => serving.get(id) === settled && serving.delete(id));
  return run;
}

/** The serve of each app in progress (the last one started). */
const serving = new Map<string, Promise<unknown>>();

async function serveNow(dataDir: string, id: string): Promise<string | null> {
  if (typeof id !== "string" || !ID_SITE.test(id)) return null;
  try {
    const sites = PathUtils.join(dataDir, "espace", "sites");
    const sitesReal = realPath(sites);
    if (!sitesReal || isLink(sites) || !(await IOUtils.getChildren(sites)).some((c) => name(c) === id)) return null;
    const source = PathUtils.join(sites, id, "accueil");
    // realpath resolves every link on the path: if it differs from the expected path, a link (or another case) is there.
    const expected = PathUtils.join(sitesReal, id, "accueil");
    if (realPath(source) !== expected) return null;
    const token = Services.uuid.generateUUID().toString().replace(/[{}-]/g, "");
    const key = `${id}-${token}`;
    const copies = PathUtils.join(dataDir, "webaios-sites", id);
    const target = PathUtils.join(copies, token);
    await IOUtils.makeDirectory(copies, { createAncestors: true, ignoreExisting: true });
    // The copies stay inside <dataDir>/webaios-sites: a copies folder that is a link is refused.
    const root = realPath(PathUtils.join(dataDir, "webaios-sites"));
    if (!root || realPath(copies) !== PathUtils.join(root, id)) return null;
    await IOUtils.makeDirectory(target, { ignoreExisting: true });
    let index = false;
    const copy = async (from: string, real: string, to: string, top: boolean): Promise<void> => {
      for (const child of await IOUtils.getChildren(from)) {
        const segment = name(child);
        if (!segment || segment.startsWith(".")) continue;
        const childReal = PathUtils.join(real, segment);
        if (realPath(child) !== childReal) continue;
        const info = await IOUtils.stat(child);
        const out = PathUtils.join(to, segment);
        if (info.type === "directory") {
          await IOUtils.makeDirectory(out, { ignoreExisting: true });
          await copy(child, childReal, out, false);
          continue;
        }
        // A named pipe or a device ("other") is never read.
        if (info.type !== "regular" || info.size > FICHIER_ACCUEIL_MAX || !HOME_TYPES.has(extension(segment))) continue;
        const bytes = await IOUtils.read(child, { maxBytes: FICHIER_ACCUEIL_MAX + 1 });
        // A file that grew since stat is refused, never cut.
        if (bytes.length > FICHIER_ACCUEIL_MAX) continue;
        if (/\.html$/i.test(segment)) await IOUtils.writeUTF8(out, homeServed(new TextDecoder().decode(bytes), key));
        else await IOUtils.write(out, bytes);
        if (top && segment === "index.html") index = true;
      }
    };
    await copy(source, expected, target, true);
    // One copy per app: the previous ones go.
    for (const old of await IOUtils.getChildren(copies)) if (old !== target) await IOUtils.remove(old, { recursive: true, ignoreAbsent: true });
    const previous = current.get(id);
    if (previous) substitute(previous, null);
    current.delete(id);
    if (!index) return null;
    // Content access: without it the home's opaque frame cannot load its own images, scripts or styles (measured). Any
    // content principal may then load these URLs as <script>, stylesheet or <img>: hence the random host. The CSP keeps
    // each home to its own copy's files.
    substitute(substitution(key), target);
    current.set(id, substitution(key));
    return `resource://${substitution(key)}/index.html`;
  } catch (e) {
    console.error(`[sites] accueil de ${id} non servi :`, e);
    return null;
  }
}

/** The host of the copy app `id`'s home is served under now (`webaios-site-<id>-<token>`), or undefined. */
export const servedHost = (id: string): string | undefined => current.get(id);

/** « Supprimer »: the app's served home goes, its substitution and its copies. */
export async function forgetHome(dataDir: string, id: string): Promise<void> {
  if (typeof id !== "string" || !ID_SITE.test(id)) return;
  // A serve still running would publish again after this.
  await serving.get(id);
  const name = current.get(id);
  current.delete(id);
  if (name) substitute(name, null);
  await IOUtils.remove(PathUtils.join(dataDir, "webaios-sites", id), { recursive: true, ignoreAbsent: true });
}

// --- Images: a copy of Electron's chargerImage (main/image-distante.ts), on Uint8Array instead of Buffer. Drift test
// in site-home.test.ts.

export interface ImageRequest {
  on(event: "redirect", cb: (status: number, method: string, to: string) => void): unknown;
  on(event: "response", cb: (r: ImageResponse) => void): unknown;
  on(event: "error" | "abort", cb: () => void): unknown;
  followRedirect(): void;
  abort(): void;
  end(): void;
}
export interface ImageResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  on(event: "data", cb: (chunk: Uint8Array) => void): unknown;
  on(event: "end" | "error" | "aborted", cb: () => void): unknown;
}
export type OpenRequest = (url: string, o: { cookies: boolean }) => ImageRequest;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Electron's chargerImage. */
export function loadImage(ouvrir: OpenRequest, url: string, o: { permise: (url: string) => boolean; cookies: boolean; max: number }): Promise<{ type: string; corps: Uint8Array } | null> {
  if (!o.permise(url)) return Promise.resolve(null);
  return new Promise((rendre) => {
    let fini = false;
    let sauts = 0;
    let actuelle = url;
    let requete: ImageRequest | undefined;
    const finir = (v: { type: string; corps: Uint8Array } | null) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuterie);
      if (v === null)
        try {
          requete?.abort();
        } catch {
          // already over
        }
      rendre(v);
    };
    const minuterie = setTimeout(() => finir(null), DELAI_IMAGE_MS);
    try {
      requete = ouvrir(url, { cookies: o.cookies });
      requete.on("redirect", (_statut, _methode, vers) => {
        if (fini) return;
        let suivante: string;
        try {
          suivante = new URL(vers, actuelle).href;
        } catch {
          return finir(null);
        }
        // A hostile page could redirect to a third party, the machine or the local network: checked before going.
        if (sauts >= REDIRECTIONS_IMAGE || !o.permise(suivante)) return finir(null);
        sauts++;
        actuelle = suivante;
        requete!.followRedirect();
      });
      requete.on("response", (r) => {
        if (fini) return;
        const type = first(r.headers["content-type"])?.split(";")[0]?.trim().toLowerCase() ?? "";
        if (r.statusCode < 200 || r.statusCode >= 300 || !TYPE_IMAGE.test(type) || Number(first(r.headers["content-length"]) ?? 0) > o.max) return finir(null);
        const morceaux: Uint8Array[] = [];
        let taille = 0;
        r.on("data", (m) => {
          if (fini) return;
          taille += m.length;
          if (taille > o.max) return finir(null);
          morceaux.push(m);
        });
        r.on("end", () => {
          const corps = new Uint8Array(taille);
          let i = 0;
          for (const m of morceaux) corps.set(m, (i += m.length) - m.length);
          finir({ type, corps });
        });
        r.on("error", () => finir(null));
        r.on("aborted", () => finir(null));
      });
      requete.on("error", () => finir(null));
      requete.on("abort", () => finir(null));
      requete.end();
    } catch {
      finir(null);
    }
  });
}

/** Electron's imagePermise: https on a domain of the app, http only to a local host (test domains), no credentials. */
function imageAllowed(url: string, domaines: readonly string[]): boolean {
  try {
    const u = new URL(url);
    const scheme = u.protocol === "https:" || (u.protocol === "http:" && adresseLocale(u.hostname));
    return scheme && !u.username && !u.password && hoteDansSite(u.hostname, domaines);
  } catch {
    return false;
  }
}

/**
 * Electron's requetesDe, on a Firefox channel in the app's container (a content principal with its userContextId, so
 * its cookies): redirects stop at the channel's event sink until the loader calls followRedirect during the event.
 */
function containerRequests(userContextId: number): OpenRequest {
  return (url) => {
    const listeners: Record<string, ((...a: any[]) => void)[]> = {};
    const emit = (event: string, ...a: unknown[]) => listeners[event]?.forEach((cb) => cb(...a));
    const on = (event: string, cb: (...a: any[]) => void) => void (listeners[event] ??= []).push(cb);
    const uri = Services.io.newURI(url);
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId });
    const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
    const channel = NetUtil.newChannel({
      uri,
      loadingPrincipal: principal,
      securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER,
    }).QueryInterface(Ci.nsIHttpChannel);
    // A channel without a window gets a cookie jar that refuses every cookie (measured): the app's, first-party.
    const jar = Cc["@mozilla.org/cookieJarSettings;1"].createInstance(Ci.nsICookieJarSettings);
    jar.initWithURI(uri, false);
    channel.loadInfo.cookieJarSettings = jar;
    // The channel of the last hop: a followed redirect goes on in a new one.
    let current = channel;
    let follow = false;
    channel.notificationCallbacks = {
      QueryInterface: ChromeUtils.generateQI(["nsIInterfaceRequestor", "nsIChannelEventSink"]),
      getInterface(iid: any) {
        return this.QueryInterface(iid);
      },
      asyncOnChannelRedirect(old: any, next: any, _flags: number, callback: any) {
        follow = false;
        let status = 0;
        try {
          status = old.QueryInterface(Ci.nsIHttpChannel).responseStatus;
        } catch {
          // no status
        }
        emit("redirect", status, "GET", next.URI.spec);
        if (follow) current = next.QueryInterface(Ci.nsIHttpChannel);
        // Not followed during the event: the next request is never sent.
        callback.onRedirectVerifyCallback(follow ? Cr.NS_OK : Cr.NS_BINDING_ABORTED);
      },
    };
    const header = (h: string) => {
      try {
        return current.getResponseHeader(h);
      } catch {
        return undefined;
      }
    };
    let response: { on: (event: string, cb: (...a: any[]) => void) => void } | null = null;
    const rlisteners: Record<string, ((...a: any[]) => void)[]> = {};
    const remit = (event: string, ...a: unknown[]) => rlisteners[event]?.forEach((cb) => cb(...a));
    return {
      on: on as ImageRequest["on"],
      followRedirect: () => void (follow = true),
      abort: () => current.cancel(Cr.NS_BINDING_ABORTED),
      end() {
        channel.asyncOpen({
          QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
          onStartRequest() {
            let statusCode = 0;
            try {
              statusCode = current.responseStatus;
            } catch {
              return emit("error");
            }
            response = { on: (event, cb) => void (rlisteners[event] ??= []).push(cb) };
            const headers: Record<string, string> = {};
            for (const h of ["content-type", "content-length"]) {
              const v = header(h);
              if (v !== undefined) headers[h] = v;
            }
            emit("response", { statusCode, headers, on: response.on });
          },
          onDataAvailable(_request: unknown, stream: any, _offset: number, count: number) {
            const input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
            input.setInputStream(stream);
            remit("data", new Uint8Array(input.readByteArray(count)));
          },
          onStopRequest(_request: unknown, status: number) {
            if (!response) return emit("error");
            if (Components.isSuccessCode(status)) remit("end");
            else remit("aborted");
          },
        });
      },
    };
  };
}

/** Image loads of each app (by container): running and waiting. */
const queues = new Map<number, { running: number; waiting: (() => void)[] }>();

/**
 * A site image the home asks for, as a `data:` URL: Electron's imageSite, loaded in the app's container, at most
 * IMAGES_AT_ONCE at once per app, IMAGES_WAITING_MAX waiting (more are refused). null if refused.
 */
export async function siteImage(userContextId: number, url: string, domaines: string[]): Promise<string | null> {
  let q = queues.get(userContextId);
  if (!q) queues.set(userContextId, (q = { running: 0, waiting: [] }));
  if (q.running < IMAGES_AT_ONCE) q.running++;
  else if (q.waiting.length >= IMAGES_WAITING_MAX) return null;
  // The place is handed over by the one who frees it (running stays the same).
  else await new Promise<void>((ok) => q!.waiting.push(ok));
  try {
    const image = await loadImage(containerRequests(userContextId), url, { permise: (u) => imageAllowed(u, domaines), cookies: true, max: IMAGE_SITE_MAX });
    if (!image) return null;
    let binary = "";
    for (let i = 0; i < image.corps.length; i += 0x8000) binary += String.fromCharCode(...image.corps.subarray(i, i + 0x8000));
    return `data:${image.type};base64,${btoa(binary)}`;
  } finally {
    const next = q.waiting.shift();
    if (next) next();
    else q.running--;
  }
}
