import type { IdProfil } from "../../../navigateur/src/commun/modele";
import { cumulerParties, HTML_MAX, profilsLisibles, urlPermise } from "../../../navigateur/src/main/agent/lecture-invisible";
import { ProfilRefuse, type OptionsLecturePage, type PageLue } from "../shims/noyau";
import { containerFor } from "../store/containers";
import type { Store } from "../store/store";
import { guardContainer, localLiteral, watchReading } from "./local-guard";
import { pacedTarget } from "./paced";

const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");

// Electron's limits (apps/navigateur/src/main/agent/lecture-invisible.ts).
const LECTURES_SIMULTANEES = 2;
const DELAI_TOTAL_MS = 30_000;
const TROP_LENTE = "Page trop lente : 30 s dépassées";
const MARGE_LECTURE_FORCEE_MS = 4_000;
const CALME_MS = 2_000;
const MAX_TEXTE = 20_000;
const MAX_LIENS = 400;
const MAX_TEXTE_DEFILEE = 100_000;
const MAX_LIENS_DEFILEE = 1_000;
const CALME_DEFILEMENT_MS = 1_000;
const RELEVE_MS = 250;
const DEFILER_MAX = 20;
const MAX_SAUTS = 5;

/** Waits for the turn of a host (the host's `lecture.changerHote`). */
type WaitHost = (lecture: string, hote: string, signal?: AbortSignal) => Promise<void>;

/** A paced read stopped at a document of another site: to resume on `target` after that site's turn. */
class Redirection extends Error {
  constructor(readonly target: string) {
    super(`Redirection vers ${hostOf(target)}`);
  }
}

/** An empty privileged page that hosts the <browser>, as BackgroundPageThumbs does. */
const HOST_PAGE = "chrome://global/content/backgroundPageThumbs.xhtml";
const PUBLIC_IDENTITY = "userContextIdInternal.webaios-reading";

interface Parts {
  titre: unknown;
  texte: unknown;
  liens: unknown;
}
interface Bounds {
  texte: number;
  liens: number;
}

/** What one read asks the page actor, and how the answer (untrusted: a web process) is shaped. */
interface Reading<T> {
  read(actor: any): Promise<unknown>;
  shape(url: string, raw: unknown): T;
  /** With scrolling: joins the readings taken before each scroll and the final one. */
  cumulate?(readings: unknown[]): unknown;
}

const hostOf = (raw: string) => {
  try {
    return new URL(raw).hostname;
  } catch {
    return "?";
  }
};

// Two reads at a time; a freed place goes straight to the next. An aborted read leaves the queue without a place.
let running = 0;
const queue: (() => void)[] = [];
async function takePlace(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (running < LECTURES_SIMULTANEES) {
    running++;
    return;
  }
  await new Promise<void>((ok, ko) => {
    const serve = () => {
      signal?.removeEventListener("abort", leave);
      ok();
    };
    const leave = () => {
      const i = queue.indexOf(serve);
      if (i >= 0) queue.splice(i, 1);
      ko(signal!.reason);
    };
    queue.push(serve);
    signal?.addEventListener("abort", leave, { once: true });
  });
}
function givePlace(): void {
  const next = queue.shift();
  if (next) next();
  else running--;
}

/** Like `p`, but rejected with `signal.reason` as soon as it aborts. */
function untilSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((ok, ko) => {
    const stop = () => ko(signal.reason);
    p.then(ok, ko).finally(() => signal.removeEventListener("abort", stop));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Private containers of public reads, one per read at a time: two reads never clear each other's cookies. */
const freePublic: number[] = [];
let publicCount = 0;
function takePublic(): number {
  const free = freePublic.pop();
  if (free !== undefined) return free;
  const name = publicCount++ ? `${PUBLIC_IDENTITY}-${publicCount}` : PUBLIC_IDENTITY;
  // Firefox has no API to create a named private identity other than this one; it is kept across restarts.
  const id: number = (ContextualIdentityService.getPrivateIdentity(name) ?? ContextualIdentityService.createForPolicy(name)).userContextId;
  guardContainer(id);
  return id;
}

// Private browsing data is tied to privateBrowsingId: a pattern without it leaves a private read's cookies behind.
const clearContainer = (userContextId: number) =>
  new Promise<void>((ok) =>
    Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId, privateBrowsingId: 1 }, { onDataDeleted: () => ok() }),
  );

/**
 * A windowless browser hosting one remote <browser> in `userContextId` (BackgroundPageThumbs.sys.mjs).
 * `private`: a private window, so that add-ons without private access (webRequest included) never see the page.
 */
async function createBrowser(userContextId: number, o: { private: boolean }): Promise<{ browser: any; close(): void }> {
  const flags =
    Ci.nsIWebBrowserChrome.CHROME_REMOTE_WINDOW |
    Ci.nsIWebBrowserChrome.CHROME_FISSION_WINDOW |
    (o.private ? Ci.nsIWebBrowserChrome.CHROME_PRIVATE_WINDOW : 0);
  const windowless = Services.appShell.createWindowlessBrowser(true, flags);
  const close = () => windowless.close();
  try {
    await new Promise<void>((ok) => {
      const progress = windowless.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIWebProgress);
      const listener = {
        QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
        onStateChange(_p: unknown, request: unknown, state: number) {
          if (!request || !(state & Ci.nsIWebProgressListener.STATE_STOP) || !(state & Ci.nsIWebProgressListener.STATE_IS_NETWORK)) return;
          progress.removeProgressListener(listener);
          ok();
        },
      };
      progress.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_ALL);
      windowless.loadURI(Services.io.newURI(HOST_PAGE), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    });
    const doc = windowless.document;
    const browser = doc.createXULElement("browser");
    for (const [k, v] of Object.entries({
      type: "content",
      remote: "true",
      maychangeremoteness: "true",
      disableglobalhistory: "true",
      messagemanagergroup: "webaios-reading",
      manualactiveness: "true",
      usercontextid: String(userContextId),
    }))
      browser.setAttribute(k, v);
    browser.style.width = "1280px";
    browser.style.height = "900px";
    doc.documentElement.appendChild(browser);
    // No sandbox flags on the read's top document: Firefox refuses a COOP page in a sandboxed one (Google, YouTube).
    // Without them, print() and alert() open no window and do not hang the read, popups need a user gesture a read
    // never makes (both checked by e2e); downloads are refused by WebAiOsReadingChild, asked here first.
    for (const until = Date.now() + 5_000; !browser.browsingContext.currentWindowGlobal; await new Promise((r) => setTimeout(r, 10)))
      if (Date.now() > until) throw new Error("Préparation de la page impossible");
    await browser.browsingContext.currentWindowGlobal.getActor("WebAiOsReading").sendQuery("prepare");
    browser.browsingContext.mediaController?.mute();
    // Not throttled as a background tab (Electron's backgroundThrottling: false).
    browser.docShellIsActive = true;
    return { browser, close };
  } catch (e) {
    close();
    throw e;
  }
}

/**
 * Loads `url` in a windowless browser (`profil` null: a private container emptied first; else a login profile's
 * container that no private space uses, or ProfilRefuse) and reads it with `reading`. Same guards, same two places,
 * same 30 s for every read. `signal` aborts the read, waiting or running, closes its browser, rejects with its reason.
 */
async function load<T>(
  store: Store,
  url: string,
  o: OptionsLecturePage & { menagee?: string },
  signal: AbortSignal | undefined,
  reading: Reading<T>,
  screens: number,
  waitHost?: WaitHost,
): Promise<T> {
  const { profil, domaines } = o;
  const allowLocal = o.adressesLocales === true;
  const allowed = (u: string) => urlPermise(u, domaines, true) && (allowLocal || !localLiteral(hostOf(u)));
  const checkProfile = () => {
    if (profil !== null && !profilsLisibles(store.state).includes(profil)) throw new ProfilRefuse(profil);
  };
  checkProfile();
  if (!allowed(url)) throw new Error(`Adresse refusée pour une lecture : ${hostOf(url)}`);
  const paced = o.menagee !== undefined && waitHost !== undefined;
  let target = url;
  // Fixed when the first page starts loading: paced redirections and their waits count in the 30 s.
  let deadline = 0;
  // One private container for the whole read: a redirected target sees the redirector's cookies, as in an ordinary redirect.
  let publicId: number | undefined;
  try {
    for (let jumps = 0; ; jumps++) {
      await takePlace(signal);
      let opened: { browser: any; close(): void } | undefined;
      let redirection: string;
      try {
        // The state may have changed while waiting for a place.
        checkProfile();
        signal?.throwIfAborted();
        if (jumps > 0 && Date.now() >= deadline) throw new Error(TROP_LENTE);
        if (profil === null && publicId === undefined) await untilSignal(clearContainer((publicId = takePublic())), signal);
        // Not raced with the signal: the browser must exist to be closed; readIn rejects at once if it aborted meanwhile.
        opened = await createBrowser(publicId ?? containerFor(profil as IdProfil), { private: profil === null });
        deadline ||= Date.now() + DELAI_TOTAL_MS;
        const page = await readIn(opened.browser, target, { allowed, allowLocal, paced }, reading, deadline, signal, screens);
        // The profile went to a private space during the read: what was read does not leave.
        checkProfile();
        return page;
      } catch (e) {
        if (!(e instanceof Redirection)) throw e;
        redirection = e.target;
      } finally {
        opened?.close();
        givePlace();
      }
      // Another site (paced read): its turn is awaited holding no browser nor place, else two reads redirected to the
      // site of a third, itself waiting for a place, would block every read. A loop between sites fails fast.
      if (jumps >= MAX_SAUTS) throw new Error("Trop de redirections");
      await untilDeadline((s) => waitHost!(o.menagee!, new URL(redirection).hostname, s), deadline, signal);
      target = redirection;
    }
  } finally {
    // Emptied after the read too, once its page is gone: no cookie, storage nor service worker waits for the next one.
    if (publicId !== undefined) {
      await clearContainer(publicId);
      freePublic.push(publicId);
    }
  }
}

/** Runs `f`, rejected with the too-slow error at `deadline` and with `signal.reason` if it aborts; `f`'s own signal aborts on either. */
function untilDeadline<T>(f: (s: AbortSignal) => Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error(TROP_LENTE)), Math.max(0, deadline - Date.now()));
  const relay = () => stop.abort(signal!.reason);
  signal?.addEventListener("abort", relay, { once: true });
  return untilSignal(f(stop.signal), stop.signal).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  });
}

/** The number of screens to scroll: an integer from 0 to 20 (anything else: 0). */
function screensOf(defiler: unknown): number {
  return typeof defiler === "number" && Number.isInteger(defiler) && defiler > 0 ? Math.min(defiler, DEFILER_MAX) : 0;
}

/** Electron's `mettreEnForme` (not exported): the page may have influenced everything but the types and the bounds. */
function shapePage(url: string, p: Parts, b: Bounds): PageLue {
  const liens: PageLue["liens"] = [];
  const vus = new Set<string>();
  for (const l of Array.isArray(p.liens) ? (p.liens as unknown[]) : []) {
    if (liens.length >= b.liens) break;
    const brut = (l as { url?: unknown; texte?: unknown } | null) ?? {};
    const lien = typeof brut.url === "string" ? brut.url : "";
    if (!/^https?:\/\//i.test(lien) || vus.has(lien)) continue;
    vus.add(lien);
    liens.push({ texte: String(brut.texte ?? "").replace(/\s+/g, " ").trim(), url: lien });
  }
  return { url, titre: String(p.titre ?? ""), texte: String(p.texte ?? "").slice(0, b.texte), liens };
}

/** Reads a page invisibly, public (`profil: null`) or with a login profile no private space uses. Nothing is kept. */
export function readPage(
  store: Store,
  url: string,
  o: OptionsLecturePage & { menagee?: string },
  signal?: AbortSignal,
  waitHost?: WaitHost,
): Promise<PageLue> {
  const screens = screensOf(o.defiler);
  const bounds = screens > 0 ? { texte: MAX_TEXTE_DEFILEE, liens: MAX_LIENS_DEFILEE } : { texte: MAX_TEXTE, liens: MAX_LIENS };
  return load(store, url, o, signal, {
    read: (actor) => actor.sendQuery("read", bounds),
    shape: (u, raw) => shapePage(u, (raw ?? { titre: "", texte: "", liens: [] }) as Parts, bounds),
    cumulate: cumulerParties,
  }, screens, waitHost);
}

/** The HTML of a public page (2 MB at most), always in an emptied private container; `url` is the final address. */
export function readHtml(store: Store, url: string, o: { adressesLocales?: boolean }, signal?: AbortSignal): Promise<{ url: string; html: string }> {
  return load(store, url, { profil: null, adressesLocales: o.adressesLocales === true }, signal, {
    read: (actor) => actor.sendQuery("html", { max: HTML_MAX }),
    shape: (u, raw) => ({ url: u, html: typeof raw === "string" ? raw.slice(0, HTML_MAX) : "" }),
  }, 0);
}

/**
 * Electron's `lireDans`: loads `url`, waits for the load then 2 s of calm (until `deadline` at most), scrolls if asked,
 * reads. Every request is guarded (`watchReading`); a top-level navigation outside `allowed` stops the read.
 */
function readIn<T>(
  browser: any,
  url: string,
  g: { allowed: (u: string) => boolean; allowLocal: boolean; paced?: boolean },
  reading: Reading<T>,
  deadline: number,
  signal: AbortSignal | undefined,
  screens: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let loaded = false;
    let inRead = false;
    let loading = false;
    const forcedAt = deadline - MARGE_LECTURE_FORCEE_MS;
    let calm: ReturnType<typeof setTimeout> | undefined;
    let pause: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const readings: unknown[] = [];
    const finish = (r: { error: Error } | { page: T }) => {
      if (done) return;
      done = true;
      clearTimeout(calm);
      clearTimeout(forced);
      clearTimeout(limit);
      clearTimeout(pause);
      wake?.();
      unwatch();
      browser.removeProgressListener(listener);
      signal?.removeEventListener("abort", abort);
      if ("error" in r) reject(r.error);
      else resolve(r.page);
    };
    const block = (target: string) => finish({ error: new Error(`Navigation bloquée : ${hostOf(target)} est hors des domaines permis`) });
    const abort = () => finish({ error: signal!.reason });
    const current = () => browser.currentURI?.spec ?? "";
    const actor = () => browser.browsingContext.currentWindowGlobal.getActor("WebAiOsPage");

    // Ended on finish: the browser stays guarded for local addresses (its unload, a pagehide beacon, comes later).
    // A paced read also stops at a document of another site than the one it started on (resumed after its turn).
    const unwatch = watchReading(browser, {
      allowLocal: g.allowLocal,
      allowTop: (u) => g.allowed(u) && !(g.paced && pacedTarget(url, u)),
      onBlocked: (u) => (g.allowed(u) ? finish({ error: new Redirection(u) }) : block(u)),
    });
    const waitCalm = () => {
      clearTimeout(calm);
      calm = setTimeout(() => void (screens > 0 ? scrollThenRead() : read()), CALME_MS);
    };
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onStateChange(progress: any, request: any, state: number, status: number) {
        const L = Ci.nsIWebProgressListener;
        if (!progress.isTopLevel || !(state & L.STATE_IS_NETWORK)) return;
        // The <browser>'s initial blank page is not the read.
        if (request instanceof Ci.nsIChannel && request.URI.spec === "about:blank") return;
        if (state & L.STATE_START) {
          loading = true;
          clearTimeout(calm);
        } else if (state & L.STATE_STOP) {
          loading = false;
          // NS_BINDING_ABORTED: a navigation replaced by another (script redirect, meta refresh), not a failure.
          // NS_ERROR_WONT_HANDLE_CONTENT: a download refused (WebAiOsReadingChild), e.g. a link with `download`; the page
          // already shown stays and is read. With nothing shown yet, the read itself was the download: it fails.
          // Not in Cr: compared by name.
          const refused = ChromeUtils.getXPCOMErrorName(status) === "NS_ERROR_WONT_HANDLE_CONTENT" && current() !== "about:blank";
          if (!Components.isSuccessCode(status) && status !== Cr.NS_BINDING_ABORTED && !refused)
            return finish({ error: new Error(`Page non chargée : ${ChromeUtils.getXPCOMErrorName(status)}`) });
          // The shown page stays: its calm, cut by this navigation's start, resumes.
          if (!Components.isSuccessCode(status)) return void (loaded && waitCalm());
          const first = !loaded;
          loaded = true;
          // Past the forced-read time already (slow page): read as is.
          if (first && Date.now() >= forcedAt) return void read();
          waitCalm();
        }
      },
    };
    browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_ALL);
    browser.addEventListener("oop-browser-crashed", () => finish({ error: new Error("La page s'est arrêtée pendant la lecture") }));

    const read = async () => {
      if (done || inRead) return;
      inRead = true;
      clearTimeout(calm);
      await readNow();
    };
    const readNow = async () => {
      if (done) return;
      try {
        const before = current();
        if (!g.allowed(before)) return block(before);
        const raw = await reading.read(actor());
        // pushState/replaceState may have changed the URL: it must stay allowed.
        const after = current();
        if (!g.allowed(after)) return block(after);
        const all = reading.cumulate && readings.length > 0 ? reading.cumulate([...readings, raw]) : raw;
        finish({ page: reading.shape(after, all) });
      } catch (e) {
        finish({ error: e instanceof Error ? e : new Error(String(e)) });
      }
    };
    const sleep = (ms: number) =>
      new Promise<void>((ok) => {
        wake = ok;
        pause = setTimeout(ok, ms);
      });
    const measure = async (name: string): Promise<{ hauteur: number; bas: boolean }> => {
      const raw = (await actor().sendQuery(name)) as { hauteur?: unknown; bas?: unknown } | null;
      return { hauteur: typeof raw?.hauteur === "number" ? raw.hauteur : 0, bas: raw?.bas === true };
    };
    /** Electron's `defilerPuisLire`: one screen at a time until `screens`, the bottom of a page that stopped growing, or the forced read. */
    const scrollThenRead = async () => {
      if (done || inRead) return;
      inRead = true;
      clearTimeout(calm);
      try {
        for (let n = 0; n < screens && Date.now() < forcedAt; n++) {
          const here = current();
          if (!g.allowed(here)) return block(here);
          // What the page shows before scrolling: a virtualized list removes it afterwards.
          if (reading.cumulate) {
            readings.push(await reading.read(actor()));
            if (done) return;
          }
          const { hauteur: before } = await measure("scroll");
          let m = { hauteur: before, bas: false };
          let height = -1;
          let since = Date.now();
          for (;;) {
            if (done) return;
            m = await measure("measure");
            if (done) return;
            const now = Date.now();
            if (m.hauteur !== height || loading) {
              height = m.hauteur;
              since = now;
            }
            if (now >= forcedAt || now - since >= CALME_DEFILEMENT_MS) break;
            await sleep(Math.min(RELEVE_MS, forcedAt - now));
          }
          if (m.bas && m.hauteur <= before) break;
        }
      } catch {
        // A scroll failed (the page navigates): no more scrolling, read at the next calm or the forced read.
        if (done) return;
        screens = 0;
        inRead = false;
        if (loaded && !loading) waitCalm();
        return;
      }
      await readNow();
    };
    const forced = setTimeout(() => {
      if (loaded) void read();
    }, Math.max(0, forcedAt - Date.now()));
    const limit = setTimeout(() => finish({ error: new Error(TROP_LENTE) }), Math.max(0, deadline - Date.now()));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    // shortcut: a top-level navigation to a custom scheme (mailto:, an app's own) may show the external app dialog,
    // nothing blocks it in the reading browser; upgrade with a content-dispatch guard if reads hit such pages.
    try {
      const uri = Services.io.newURI(url);
      browser.loadURI(uri, {
        triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId: Number(browser.getAttribute("usercontextid")) }),
        loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_HISTORY,
      });
    } catch (e) {
      finish({ error: e instanceof Error ? e : new Error(String(e)) });
    }
  });
}
