// The design mode in the chrome (spec §5.4-5.5): Electron's ServiceDesign (main/design/service.ts:142-468) on the
// WebAiOsDesign actor (chrome/agent/design-actor.ts, packaged: never changed here) and the targets' <browser>s.
// The actor's limits are handled here: a frame's guard has no timeout (every frame guarded is unguarded on every exit),
// a second arm may leave the first pending (never armed twice, stale answers dropped by generation), and its stop may
// throw or hang (timed out, then the top window is unguarded).
import type { ApiCalque, ContexteCalque, ElementAffiche, EtatDesign, LotAffiche, ResultatExtension } from "../../../navigateur/src/commun/api";
import type { IdFenetre } from "../../../navigateur/src/commun/modele";
import { HAUTEUR_BARRE_SITE } from "../../../navigateur/src/commun/sites";
import type { ContexteDesign } from "../../../../packages/noyau/src/design/remarques";
import { choisirCibleDesign } from "../../../navigateur/src/main/design/premier-plan";
import type { SuiviDesign } from "../../noyau/design";
import { CAPTURE_WARNING_SITE, DESIGN_ID_MAX, ID_PROJECT, INVALID_REQUEST, NOTHING_AIMED, REMARK_TEXT_MAX, UNAVAILABLE_DESIGN, UNAVAILABLE_DESIGN_SITE } from "../../shared/design-guards";
import type { AgentHost } from "../agent/host";
import type { apps as Apps } from "./apps";
import {
  cleanCapture,
  cleanSource,
  cleCible,
  firefoxViewfinderScript,
  HAUTEUR_MESSAGE,
  LARGEUR_MESSAGE,
  LARGEUR_PANIER,
  MARGE,
  MARGE_MESSAGE,
  placeBulle,
  rectCapture,
  SOURCE_TIMEOUT_MS,
  sourceExpression,
  STOP_SCRIPT,
  TAILLE_BULLE_SITE,
  type CaptureViseur,
} from "./design-copies";
import type { SiteApps } from "./sites";
import type { Store } from "./store";
import type { WindowRegistry } from "./windows";

export type DesignTarget = { type: "fenetre"; fenetreId: IdFenetre } | { type: "app"; dossier: string } | { type: "site"; id: string };

export interface DesignOverlays {
  show(key: string, win: Window, place: { x: number; y: number; width: number; height: number }, ctx: ContexteCalque): void;
  hide(key: string, mode: ContexteCalque["mode"]): void;
  forget(key: string): void;
  /** The main window's cart column: its « Fermer » (App.svelte decides what it stops). */
  onColumnClosed(t: DesignTarget, cb: () => void): () => void;
}

export interface DesignService {
  etat(t: DesignTarget): Promise<EtatDesign>;
  toggle(t: DesignTarget): Promise<void>;
  /** ⇧⌘D in `win`: Electron's choisirCibleDesign on that window; a site app's targets wait for plan 36. */
  shortcut(win: Window): void;
  stop(t: DesignTarget): Promise<void>;
  /** The bubble's « Ajouter ». */
  add(t: DesignTarget, texte: string): Promise<ResultatExtension>;
  /** Bubble Annuler/Escape, message click, cart « Fermer ». */
  cancel(t: DesignTarget): void;
  openCart(t: DesignTarget): Promise<void>;
  relire(t: DesignTarget): Promise<void>;
  /** What the target's overlay shows: the first of `modes` it has (the bubble, then the cart, then the message). */
  overlayContext(t: DesignTarget, modes?: ContexteCalque["mode"][]): ContexteCalque | null;
  /** Hides one overlay of the target: the message's timeout, the cart column closed by its window. */
  closeOverlay(t: DesignTarget, mode: ContexteCalque["mode"]): void;
  /** The target's window closed. */
  forget(t: DesignTarget): void;
  onChange(cb: () => void): () => void;
  /** Set by Task 3: shows and hides the overlay frames. No-op until then. */
  overlays: DesignOverlays;
}

const ACTOR = "WebAiOsDesign";
/** Mine: a stop the actor does not answer within this is given up, then the top window is unguarded. */
export const STOP_TIMEOUT_MS = 1000;
/** The actor keeps the top's guard 500 ms after a capture (the rest of a double click): the frames' too. */
const SWALLOW_MS = 500;
const XHTML = "http://www.w3.org/1999/xhtml";

interface View {
  browser: any;
  win: Window;
}

interface Session {
  target: DesignTarget;
  key: string;
  projet: SuiviDesign["projet"];
  browser: any;
  win: Window;
  /** The page's WindowGlobalParent when the mode started: the only one armed, read and captured. */
  wgp: any;
  generation: number;
  memeDocument: boolean;
  /** An arm query is pending. */
  armed: boolean;
  attente: { contexte: ContexteDesign; capture: string | null } | null;
  destination: { destination: string | null; sansDestination: string | null };
  /** The process-root frames sent a guard, until each is unguarded. */
  guarded: Set<any>;
  unguardTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(): void;
}

/** A query to the actor of `wgp`; a missing actor (destroyed, not an http(s) page) rejects. */
function ask(wgp: any, name: string, data?: unknown): Promise<unknown> {
  try {
    return Promise.resolve(wgp.getActor(ACTOR).sendQuery(name, data));
  } catch (e) {
    return Promise.reject(e);
  }
}

const within = <T>(p: Promise<T>, ms: number, late: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((ok) => (timer = setTimeout(() => ok(late), ms)))]).finally(() => clearTimeout(timer));
};

const sourceText = (s: ContexteDesign["source"]): string | null => (s ? (s.ligne !== undefined ? `${s.fichier}:${s.ligne}` : s.fichier) : null);

/**
 * The element's PNG (base64, no prefix), as Electron's capturerElement: rectCapture's rectangle in view pixels × zoom,
 * drawn by the page's WindowGlobal only (spike S2), then cut to round(size × dpr). null when empty or failed.
 */
export async function capturePng(browser: any, rect: CaptureViseur["rect"], vue: CaptureViseur["vue"], wgp: any = browser.browsingContext?.currentWindowGlobal): Promise<string | null> {
  try {
    const win = browser.ownerDocument.defaultView;
    // The home's frame (an <iframe>) has no fullZoom.
    const zoom: number = browser.fullZoom ?? 1;
    const dpr: number = win.devicePixelRatio;
    const r = rectCapture(rect, vue, zoom);
    if (r.width <= 0 || r.height <= 0 || !wgp) return null;
    const bitmap = await wgp.drawSnapshot(new win.DOMRect(r.x / zoom, r.y / zoom, r.width / zoom, r.height / zoom), zoom * dpr, "white", { drawView: true });
    const canvas = win.document.createElementNS(XHTML, "canvas");
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    const url: string = canvas.toDataURL("image/png");
    return url.slice(url.indexOf(",") + 1);
  } catch {
    return null;
  }
}

export function createDesign(o: {
  agent: AgentHost;
  windows: WindowRegistry;
  apps: typeof Apps;
  sites: Pick<SiteApps, "designView" | "infoNotice" | "controller" | "onClosed">;
  dispatch: Store["dispatch"];
  mainWindow(): Promise<IdFenetre | undefined>;
  toFront(f: IdFenetre): void;
}): DesignService {
  const sessions = new Map<string, Session>();
  /** Calques.contexte: what each key's overlay shows, the bubble first, then the cart, then the message. */
  const contexts = new Map<string, Partial<Record<ContexteCalque["mode"], ContexteCalque>>>();
  /** Each key's last openCart or close of its cart: an openCart that a close overtook shows nothing. */
  const cartAsks = new Map<string, number>();
  const askCart = (key: string) => {
    const n = (cartAsks.get(key) ?? 0) + 1;
    cartAsks.set(key, n);
    return n;
  };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const cb of listeners)
      try {
        cb();
      } catch (e) {
        console.error("[design] listener failed:", e);
      }
  };

  /** The target's page, from the chrome only: the selected tab of a main window, or an agent app's view. */
  const view = (t: DesignTarget): View | null => {
    if (t.type === "fenetre") {
      const win = o.windows.get(t.fenetreId)?.window as any;
      const browser = win && !win.closed ? win.gBrowser?.selectedBrowser : null;
      return browser ? { browser, win } : null;
    }
    if (t.type === "site") {
      const d = o.sites.designView(t.id);
      return d ? { browser: d.home ?? d.browser, win: d.win } : null;
    }
    const v = o.apps.viewFor(t.dossier);
    return v ? { browser: v.browser, win: v.window } : null;
  };
  const pageOf = (b: any) => b.browsingContext?.currentWindowGlobal;
  /** The project of the page's own document (`wgp`, the one armed), never of the <browser>'s address, which a commit moves first. */
  const suivi = (t: DesignTarget, v: View, wgp: any = pageOf(v.browser)) =>
    o.agent.request<SuiviDesign | null>(
      "design.suivi",
      t.type === "fenetre" ? { url: String(wgp?.documentURI?.spec ?? "") } : t.type === "app" ? { projet: "app-" + t.dossier } : { projet: "site-" + t.id },
    );
  const current = (s: Session, g: number) => sessions.get(s.key) === s && s.generation === g;

  const giveKeyboard = (s: Session) => {
    if (s.target.type !== "fenetre" && Services.env.get("WEBAIOS_INVISIBLE") !== "1" && !s.win.closed) s.win.focus();
    s.browser.focus();
  };

  const hide = (key: string, mode: ContexteCalque["mode"]) => {
    const c = contexts.get(key);
    if (!c?.[mode]) return;
    delete c[mode];
    service.overlays.hide(key, mode);
    notify();
  };
  const show = (key: string, win: Window, place: { x: number; y: number; width: number; height: number }, ctx: ContexteCalque) => {
    const same = JSON.stringify(contexts.get(key)?.[ctx.mode]) === JSON.stringify(ctx);
    contexts.set(key, { ...contexts.get(key), [ctx.mode]: ctx });
    service.overlays.show(key, win, place, ctx);
    // Nothing new to read: a notify would make the UI read again, and open the same cart again, in a loop.
    if (!same) notify();
  };

  const guardFrame = (s: Session, wgp: any) => {
    if (!wgp || wgp === s.wgp || !wgp.isProcessRoot) return;
    s.guarded.add(wgp);
    ask(wgp, "guard").catch(() => {});
  };
  const unguardFrames = (s: Session) => {
    clearTimeout(s.unguardTimer);
    for (const wgp of s.guarded) ask(wgp, "unguard").catch(() => {});
    s.guarded.clear();
  };
  // A process-root frame that appears while a session is armed (spec §5.4): guarded as it is created.
  Services.obs.addObserver(
    {
      observe(wgp: any) {
        const top = wgp?.browsingContext?.top;
        for (const s of sessions.values()) if (s.armed && top === s.browser.browsingContext) guardFrame(s, wgp);
      },
    },
    "window-global-created",
  );

  /** The actor's stop; if it throws or never answers, the top's guard is lifted anyway. true when it answered. */
  async function disarm(s: Session): Promise<boolean> {
    const answered = await within(ask(s.wgp, "stop", { code: STOP_SCRIPT }).then(() => true, () => false), STOP_TIMEOUT_MS, false);
    if (!answered) await within(ask(s.wgp, "unguard").then(() => true, () => false), STOP_TIMEOUT_MS, false);
    return answered;
  }

  async function arm(s: Session): Promise<void> {
    // Never a second arm while one is pending (the actor would leave the first unanswered).
    if (s.armed) return;
    const g = ++s.generation;
    s.memeDocument = false;
    if (pageOf(s.browser) !== s.wgp) return service.stop(s.target);
    s.armed = true;
    clearTimeout(s.unguardTimer);
    const answer = ask(s.wgp, "arm", { code: firefoxViewfinderScript() }).catch(() => null);
    for (const bc of s.browser.browsingContext.getAllBrowsingContextsInSubtree()) guardFrame(s, bc.currentWindowGlobal);
    const r = await answer;
    // A stale answer: whoever made it stale (stop, forget) has unguarded the frames.
    if (!current(s, g)) return;
    s.armed = false;
    if (!r) {
      unguardFrames(s);
      // A same-document navigation stopped the viewfinder: armed again, the mode stays. Else Escape, page gone: it stops.
      return s.memeDocument ? arm(s) : service.stop(s.target);
    }
    s.unguardTimer = setTimeout(() => s.armed || unguardFrames(s), SWALLOW_MS);
    const capture = cleanCapture(r);
    if (!capture) return service.stop(s.target);
    // A site app's pages: nothing is read in the page's world, the source stays unknown (Electron's armer).
    const site = s.target.type === "site";
    const source = site ? null : cleanSource(await within(ask(s.wgp, "source", { code: sourceExpression(capture.selecteur) }).catch(() => null), SOURCE_TIMEOUT_MS, null));
    if (!current(s, g)) return;
    if (pageOf(s.browser) !== s.wgp) return service.stop(s.target);
    const png = await capturePng(s.browser, capture.rect, capture.vue, s.wgp);
    if (!current(s, g)) return;
    const { rect, ...contexte } = capture;
    s.attente = { contexte: { ...contexte, source }, capture: png };
    const v = view(s.target);
    if (v?.browser !== s.browser || pageOf(s.browser) !== s.wgp || s.win.closed) return service.stop(s.target);
    const b = s.target.type === "site" ? o.sites.designView(s.target.id)?.bounds : s.browser.getBoundingClientRect();
    if (!b) return service.stop(s.target);
    const bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    const win: [number, number] = [s.win.innerWidth, s.win.innerHeight];
    const place = placeBulle(rect, s.browser.fullZoom ?? 1, bounds, win, site ? { hautMin: bounds.y, hauteur: TAILLE_BULLE_SITE.hauteur } : {});
    show(s.key, s.win, place, { mode: "bulle", message: null, projet: s.projet.projet, etiquette: contexte.etiquette, source: sourceText(source), ...s.destination, avertissement: site ? CAPTURE_WARNING_SITE : null });
  }

  /** A throw anywhere after the arm (a bug, a window gone mid-way): the session stops, its frames unguarded. */
  const armSafe = (s: Session) =>
    arm(s).catch((e) => {
      console.error("[design] arm failed:", e);
      unguardFrames(s);
      return service.stop(s.target);
    });

  // A window id comes back when the last window reopens (windows.ts keeps it): a closed agent app window forgets its target too.
  o.apps.onClosed(() => {
    for (const key of new Set([...sessions.keys(), ...contexts.keys()]))
      if (key.startsWith("app:") && !o.apps.viewFor(key.slice(4))) service.forget({ type: "app", dossier: key.slice(4) });
  });
  o.sites.onClosed(() => {
    for (const key of new Set([...sessions.keys(), ...contexts.keys()]))
      if (key.startsWith("site:") && !o.sites.designView(key.slice(5))) service.forget({ type: "site", id: key.slice(5) });
  });

  const service: DesignService = {
    overlays: { show() {}, hide() {}, forget() {}, onColumnClosed: () => () => {} },

    async etat(t) {
      const s = sessions.get(cleCible(t));
      const v = s ? null : view(t);
      // A host that does not answer rejects: the button keeps its last state.
      const r = s ? await o.agent.request<SuiviDesign | null>("design.suivi", { projet: s.projet.projet }) : v ? await suivi(t, v) : null;
      const projet = r?.projet ?? s?.projet ?? null;
      if (!projet) return { actif: false, projet: null, indisponible: t.type === "site" ? UNAVAILABLE_DESIGN_SITE : UNAVAILABLE_DESIGN, destination: null, sansDestination: null, panier: 0, nom: "" };
      // A site app: its project is known even where the mode does not start (card, sign-in page, fullscreen).
      const indisponible = t.type === "site" && !s && !o.sites.designView(t.id)?.available ? UNAVAILABLE_DESIGN_SITE : null;
      return { actif: !!s, projet, indisponible, destination: r?.destination ?? null, sansDestination: r?.sansDestination ?? null, panier: r?.panier ?? 0, nom: r?.nom ?? "" };
    },

    async toggle(t) {
      const key = cleCible(t);
      if (sessions.has(key)) return service.stop(t);
      const site = t.type === "site" ? o.sites.designView(t.id) : null;
      // Unavailable in the site app's window: why, in its bar; nothing injected.
      if (t.type === "site" && !site?.available) return o.sites.infoNotice(t.id, UNAVAILABLE_DESIGN_SITE);
      const v = view(t);
      if (!v) return;
      // The page whose address gives the project, read with the address: the only one ever armed.
      const wgp = pageOf(v.browser);
      const r = await suivi(t, v, wgp).catch(() => undefined);
      if (!r || !wgp || sessions.has(key) || view(t)?.browser !== v.browser || pageOf(v.browser) !== wgp) {
        // A tab outside the followed projects (the host said so): why nothing happens, nothing injected.
        if (r === null && t.type === "fenetre" && !sessions.has(key) && view(t)?.browser === v.browser) {
          const b = v.browser.getBoundingClientRect();
          const place = { x: b.x + b.width - MARGE_MESSAGE - LARGEUR_MESSAGE, y: b.y + MARGE_MESSAGE, width: LARGEUR_MESSAGE, height: HAUTEUR_MESSAGE };
          show(key, v.win, place, { mode: "message", message: UNAVAILABLE_DESIGN, projet: "", etiquette: "", source: null, destination: null, sansDestination: null, avertissement: null });
        }
        return;
      }
      const { browser, win } = v;
      const gBrowser = (win as any).gBrowser;
      const off = () => void service.stop(t);
      const progress = {
        onLocationChange(b: any, webProgress: any, _request: unknown, _location: unknown, flags: number) {
          if (b !== browser || !webProgress.isTopLevel) return;
          if (!(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) return off();
          s.memeDocument = true;
          // The viewfinder is stopped, its null answer arms it again; a stop that never answers ends the mode.
          if (s.armed) void disarm(s).then((ok) => ok || (s.armed && sessions.get(key) === s && off()));
        },
      };
      const onSelect = () => gBrowser.selectedBrowser !== browser && off();
      const onClose = (e: any) => e.target?.linkedBrowser === browser && off();
      const onCrash = (e: any) => e.isTrusted && e.originalTarget === browser && off();
      const onUnload = () => service.forget(t);
      // A site app's own stops: ⌂, « Entrer dans le site », an element's fullscreen.
      const offState =
        t.type === "site" && site
          ? o.sites.controller(t.id)?.onState((e) => (e.vue !== site.vue || win.document.documentElement.hasAttribute("inDOMFullscreen")) && off())
          : undefined;
      gBrowser.addTabsProgressListener(progress);
      gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
      gBrowser.tabContainer.addEventListener("TabClose", onClose);
      // Window capture: before tabs.ts's handler, which stops it at the tab panels.
      win.addEventListener("oop-browser-crashed", onCrash, true);
      win.addEventListener("unload", onUnload);
      const s: Session = {
        target: t, key, projet: r.projet, browser, win, wgp, generation: 0, memeDocument: false, armed: false, attente: null,
        destination: { destination: r.destination, sansDestination: r.sansDestination }, guarded: new Set(), unguardTimer: undefined,
        cleanup: () => {
          offState?.();
          gBrowser.removeTabsProgressListener(progress);
          gBrowser.tabContainer.removeEventListener("TabSelect", onSelect);
          gBrowser.tabContainer.removeEventListener("TabClose", onClose);
          win.removeEventListener("oop-browser-crashed", onCrash, true);
          win.removeEventListener("unload", onUnload);
        },
      };
      sessions.set(key, s);
      notify();
      giveKeyboard(s);
      void armSafe(s);
    },

    shortcut(win) {
      const doc = win.document.documentElement;
      const fenetreId = (win as any).webaiosWindow?.fenetreId as IdFenetre | undefined;
      const main = !!fenetreId && o.windows.get(fenetreId)?.window === win;
      const appli = o.apps.dossierOf(win);
      const choix = choisirCibleDesign({
        appli,
        site: doc.getAttribute("webaios-site") ?? undefined,
        petiteDeSite: doc.getAttribute("webaios-site-small") ?? undefined,
        autreFenetre: !main && !appli,
        fenetreActive: main ? fenetreId : undefined,
      });
      if (choix.type === "cible" && (choix.cible.type === "fenetre" || choix.cible.type === "app")) void service.toggle(choix.cible);
    },

    async stop(t) {
      const s = sessions.get(cleCible(t));
      if (!s) return;
      sessions.delete(s.key);
      s.generation++;
      s.attente = null;
      s.armed = false;
      s.cleanup();
      unguardFrames(s);
      hide(s.key, "bulle");
      notify();
      await disarm(s);
    },

    async add(t, texte) {
      const s = sessions.get(cleCible(t));
      const attente = s?.attente;
      if (!s || !attente) return { ok: false, erreur: NOTHING_AIMED };
      let r: ResultatExtension;
      try {
        r = await o.agent.request<ResultatExtension>("design.ajouter", { projet: s.projet.projet, texte, contexte: attente.contexte, capture: attente.capture });
      } catch (e) {
        // Spec §5.10: the call's error, the mode stays.
        return { ok: false, erreur: e instanceof Error ? e.message : String(e) };
      }
      if (!r.ok || sessions.get(s.key) !== s || s.attente !== attente) return r;
      s.attente = null;
      hide(s.key, "bulle");
      giveKeyboard(s);
      void armSafe(s);
      return r;
    },

    cancel(t) {
      const key = cleCible(t);
      const s = sessions.get(key);
      if (!s?.attente) {
        hide(key, "message");
        return hide(key, "panier");
      }
      s.attente = null;
      hide(key, "bulle");
      giveKeyboard(s);
      void armSafe(s);
    },

    async openCart(t) {
      const n = askCart(cleCible(t));
      const v = view(t);
      const r = v ? await suivi(t, v).catch(() => null) : null;
      if (!v || !r || cartAsks.get(cleCible(t)) !== n) return;
      const [l, h] = [v.win.innerWidth, v.win.innerHeight];
      // A site app's cart starts under its bar (Electron's margeHaute).
      const y = t.type === "site" ? HAUTEUR_BARRE_SITE + MARGE : MARGE;
      const place = { x: Math.max(0, l - MARGE - LARGEUR_PANIER), y, width: Math.min(LARGEUR_PANIER, l), height: Math.max(0, h - y - MARGE) };
      show(cleCible(t), v.win, place, { mode: "panier", message: null, projet: r.projet.projet, etiquette: "", source: null, destination: r.destination, sansDestination: r.sansDestination, avertissement: null });
    },

    async relire(t) {
      const v = view(t);
      const r = v ? await suivi(t, v).catch(() => null) : null;
      if (!r || r.projet.type === "demo") return;
      const fenetreId = t.type === "fenetre" ? t.fenetreId : await o.mainWindow();
      if (!fenetreId) return;
      o.dispatch({ type: "ouvrirRelecture", fenetreId, projet: r.projet.projet, nom: r.nom.slice(0, 80) });
      if (t.type !== "fenetre") o.toFront(fenetreId);
    },

    overlayContext(t, modes = ["bulle", "panier", "message"]) {
      const c = contexts.get(cleCible(t));
      for (const mode of modes) if (c?.[mode]) return c[mode];
      return null;
    },

    closeOverlay(t, mode) {
      const key = cleCible(t);
      if (mode === "panier") askCart(key);
      hide(key, mode);
    },

    forget(t) {
      const key = cleCible(t);
      cartAsks.delete(key);
      void service.stop(t);
      contexts.delete(key);
      service.overlays.forget(key);
      notify();
    },

    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
  return service;
}

/**
 * An overlay frame's ApiCalque (ipc.ts's « calque » origin): its target is the chrome's, never an id the frame sends.
 * A project is allowed only if it is the one the overlay shows (projetPermis); the host checks every bound again.
 * `modes`: what this frame shows. `annuler`: the frame's own (the cart column's « Fermer »), else the service's cancel.
 */
// Trust boundary: the frame is a system-principal chrome document, so it could reach the chrome itself; this API is a
// convention for the frozen UI, and the real guards are these chrome-side checks and the host's.
export function overlayApi(
  o: { design: DesignService; host: Pick<AgentHost, "request" | "on">; modes?: ContexteCalque["mode"][]; annuler?: () => void },
  t: DesignTarget,
): ApiCalque {
  const allowed = (p: unknown): p is string => typeof p === "string" && ID_PROJECT.test(p) && o.design.overlayContext(t)?.projet === p;
  const id = (x: unknown): x is string => typeof x === "string" && x.length <= DESIGN_ID_MAX;
  // Spec §5.10, the host stopped: PanierDesign reads again after a failed send and would show a rejected read as an
  // empty cart. The last answer stands instead; a restarted host is read again (surChange).
  const last = new Map<string, unknown>();
  const read = <T>(method: string, p: string): Promise<T> =>
    o.host.request<T>(method, { projet: p }).then(
      (v) => (last.set(`${method} ${p}`, v), v),
      (e) => (last.has(`${method} ${p}`) ? (last.get(`${method} ${p}`) as T) : Promise.reject(e)),
    );
  return {
    contexte: async () => o.design.overlayContext(t, o.modes),
    async ajouter(texte) {
      if (typeof texte !== "string" || texte.length > REMARK_TEXT_MAX) return { ok: false, erreur: INVALID_REQUEST };
      return o.design.add(t, texte);
    },
    annuler: () => (o.annuler ? o.annuler() : o.design.cancel(t)),
    panier: async (p) => (allowed(p) ? read<ElementAffiche[]>("design.panier", p) : []),
    lots: async (p) => (allowed(p) ? read<LotAffiche[]>("design.lots", p) : []),
    async retirer(p, x) {
      if (allowed(p) && id(x)) await o.host.request("design.retirer", { projet: p, id: x });
    },
    async traite(p, lot) {
      if (allowed(p) && id(lot)) await o.host.request("design.traite", { projet: p, lot });
    },
    envoyer: async (p) => (allowed(p) ? o.host.request<ResultatExtension>("design.envoyer", { projet: p }) : { ok: false, erreur: INVALID_REQUEST }),
    surChange(cb) {
      // accueil.change: sent at each host start (store/index.ts), so a restarted host's cart is read again.
      const offs = [...["design.change", "accueil.change"].map((m) => o.host.on(m, () => cb())), o.design.onChange(cb)];
      return () => offs.forEach((f) => f());
    },
  };
}
