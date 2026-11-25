// The design mode in the chrome (spec §5.4-5.5): the design service on the
// RessacDesign actor (chrome/agent/design-actor.ts, packaged: never changed here) and the targets' <browser>s.
// The actor's limits are handled here: a frame's guard has no timeout (every frame guarded is unguarded on every exit),
// a second arm may leave the first pending (never armed twice, stale answers dropped by generation), and its stop may
// throw or hang (timed out, then the top window is unguarded).
import type { OverlayApi, OverlayContext, ShownElement, DesignState, BatchShown, ExtensionResult } from "../../shared/api";
import type { WindowId } from "../../shared/model";
import { SITE_BAR_HEIGHT } from "../../shared/sites";
import type { DesignContext } from "../../../../packages/kernel/src/design/remarks";
import { chooseDesignTarget, type DesignTarget } from "../../core/design/foreground";
import type { DesignTracking } from "../../host/design";
import { format } from "../../shared/i18n";
import { DESIGN_ID_MAX, ID_PROJECT, INVALID_REQUEST, NOTHING_AIMED, REMARK_TEXT_MAX } from "../../shared/design-guards";
import type { AgentHost } from "../agent/host";
import type { apps as Apps } from "./apps";
import {
  cleanCapture,
  cleanSource,
  targetKey,
  firefoxViewfinderScript,
  MESSAGE_HEIGHT,
  MESSAGE_WIDTH,
  BASKET_WIDTH,
  MARGIN,
  MESSAGE_MARGIN,
  bubbleSlot,
  rectCapture,
  SOURCE_TIMEOUT_MS,
  sourceExpression,
  STOP_SCRIPT,
  SITE_BUBBLE_SIZE,
  type ViewfinderCapture,
} from "./design-copies";
import { framesOrigin } from "../window/frames-root";
import type { SiteApps } from "./sites";
import type { Store } from "./store";
import type { WindowRegistry } from "./windows";

export type { DesignTarget };

export interface DesignOverlays {
  show(key: string, win: Window, place: { x: number; y: number; width: number; height: number }, ctx: OverlayContext): void;
  hide(key: string, mode: OverlayContext["mode"]): void;
  forget(key: string): void;
  /** The main window's cart column: its « Fermer » (App.svelte decides what it stops). */
  onColumnClosed(t: DesignTarget, cb: () => void): () => void;
}

export interface DesignService {
  state(t: DesignTarget): Promise<DesignState>;
  toggle(t: DesignTarget): Promise<void>;
  /** ⇧⌘D in `win`: the design target of that window; a site app's sign-in window: the avis in the app's bar. */
  shortcut(win: Window): void;
  stop(t: DesignTarget): Promise<void>;
  /** Every running session stops (AI switched off). */
  stopAll(): Promise<void>;
  /** The bubble's « Ajouter ». */
  add(t: DesignTarget, text: string): Promise<ExtensionResult>;
  /** Bubble Annuler/Escape, message click, cart « Fermer ». */
  cancel(t: DesignTarget): void;
  openCart(t: DesignTarget): Promise<void>;
  review(t: DesignTarget): Promise<void>;
  /** What the target's overlay shows: the first of `modes` it has (the bubble, then the cart, then the message). */
  overlayContext(t: DesignTarget, modes?: OverlayContext["mode"][]): OverlayContext | null;
  /** Hides one overlay of the target: the message's timeout, the cart column closed by its window. */
  closeOverlay(t: DesignTarget, mode: OverlayContext["mode"]): void;
  /** The target's window closed. */
  forget(t: DesignTarget): void;
  onChange(cb: () => void): () => void;
  /** Something every state shows changed (the shortcut's label): the listeners re-read. */
  refresh(): void;
  /** Set by Task 3: shows and hides the overlay frames. No-op until then. */
  overlays: DesignOverlays;
}

const ACTOR = "RessacDesign";
/** The same actor on a site app's home, a remote frame of the frames group. */
const HOME_ACTOR = "RessacDesignFrames";
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
  project: DesignTracking["project"];
  browser: any;
  win: Window;
  /** The page's WindowGlobalParent when the mode started: the only one armed, read and captured. */
  wgp: any;
  generation: number;
  sameDocument: boolean;
  /** An arm query is pending. */
  armed: boolean;
  pending: { context: DesignContext; capture: string | null } | null;
  destination: { destination: string | null; noDestination: string | null };
  /** The page's viewfinder: the actor of `wgp` (RessacDesignFrames on a site app's home). */
  query(name: "arm" | "stop" | "source" | "unguard", data?: { code?: string }): Promise<unknown>;
  /** A site app's home: `browser` is its frame. */
  home: boolean;
  /** The process-root frames sent a guard, until each is unguarded. */
  guarded: Set<any>;
  unguardTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(): void;
}

/** A query to the actor of `wgp`; a missing actor (destroyed, not an http(s) page) rejects. */
function ask(wgp: any, name: string, data?: unknown, actor = ACTOR): Promise<unknown> {
  try {
    return Promise.resolve(wgp.getActor(actor).sendQuery(name, data));
  } catch (e) {
    return Promise.reject(e);
  }
}

const within = <T>(p: Promise<T>, ms: number, late: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((ok) => (timer = setTimeout(() => ok(late), ms)))]).finally(() => clearTimeout(timer));
};

const sourceText = (s: DesignContext["source"]): string | null => (s ? (s.line !== undefined ? `${s.file}:${s.line}` : s.file) : null);

/**
 * The element's PNG (base64, no prefix): rectCapture's rectangle in view pixels × zoom,
 * drawn by the page's WindowGlobal only (spike S2), then cut to round(size × dpr). null when empty or failed.
 */
export async function capturePng(browser: any, rect: ViewfinderCapture["rect"], view: ViewfinderCapture["view"], wgp: any = browser.browsingContext?.currentWindowGlobal): Promise<string | null> {
  try {
    const win = browser.ownerDocument.defaultView;
    const zoom: number = browser.fullZoom ?? 1;
    const dpr: number = win.devicePixelRatio;
    const r = rectCapture(rect, view, zoom);
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
  mainWindow(): Promise<WindowId | undefined>;
  /** The design mode's current key label. */
  shortcutLabel(): string;
  /** The shown language, for the overlays' own texts. */
  locale(): string;
  toFront(f: WindowId): void;
  /** The effective lab (shared/tiers.ts): off, the mode does not start and the agent panel opens instead (its asleep card with AI off). */
  labOn(): boolean;
  /** Opens the window's agent panel, the window in front (design.giveAgent). */
  giveAgent(f: WindowId): void;
}): DesignService {
  const sessions = new Map<string, Session>();
  /** Calques.contexte: what each key's overlay shows, the bubble first, then the cart, then the message. */
  const contexts = new Map<string, Partial<Record<OverlayContext["mode"], OverlayContext>>>();
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
    if (t.type === "window") {
      const win = o.windows.get(t.windowId)?.window as any;
      const browser = win && !win.closed ? win.gBrowser?.selectedBrowser : null;
      return browser ? { browser, win } : null;
    }
    if (t.type === "site") {
      const d = o.sites.designView(t.id);
      return d ? { browser: d.home ?? d.browser, win: d.win } : null;
    }
    const v = o.apps.viewFor(t.folder);
    return v ? { browser: v.browser, win: v.window } : null;
  };
  const pageOf = (b: any) => b.browsingContext?.currentWindowGlobal;
  /** AI off: the asleep card in the agent panel of `f`, or of the main window for a site or an app. */
  const asleep = async (f?: WindowId) => {
    const target = f ?? (await o.mainWindow());
    if (target) o.giveAgent(target);
  };
  /** The project of the page's own document (`wgp`, the one armed), never of the <browser>'s address, which a commit moves first. */
  const tracking = (t: DesignTarget, v: View, wgp: any = pageOf(v.browser)) =>
    o.agent.request<DesignTracking | null>(
      "design.tracking",
      t.type === "window" ? { url: String(wgp?.documentURI?.spec ?? "") } : t.type === "app" ? { project: "app-" + t.folder } : { project: "site-" + t.id },
    );
  const current = (s: Session, g: number) => sessions.get(s.key) === s && s.generation === g;

  const giveKeyboard = (s: Session) => {
    if (s.target.type !== "window" && Services.env.get("RESSAC_INVISIBLE") !== "1" && !s.win.closed) s.win.focus();
    s.browser.focus();
  };

  const hide = (key: string, mode: OverlayContext["mode"]) => {
    const c = contexts.get(key);
    if (!c?.[mode]) return;
    delete c[mode];
    service.overlays.hide(key, mode);
    notify();
  };
  const UNAVAIL = () => format(o.locale(), "chrome-design-unavailable");
  const UNAVAIL_SITE = () => format(o.locale(), "chrome-design-unavailable-site");
  const show = (key: string, win: Window, place: { x: number; y: number; width: number; height: number }, shown: Omit<OverlayContext, "locale">) => {
    const ctx: OverlayContext = { ...shown, locale: o.locale() };
    const same = JSON.stringify(contexts.get(key)?.[ctx.mode]) === JSON.stringify(ctx);
    contexts.set(key, { ...contexts.get(key), [ctx.mode]: ctx });
    service.overlays.show(key, win, place, ctx);
    // Nothing new to read: a notify would make the UI read again, and open the same cart again, in a loop.
    if (!same) notify();
  };

  const guardFrame = (s: Session, wgp: any) => {
    if (s.home || !wgp || wgp === s.wgp || !wgp.isProcessRoot) return;
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
    const answered = await within(s.query("stop", { code: STOP_SCRIPT }).then(() => true, () => false), STOP_TIMEOUT_MS, false);
    if (!answered) await within(s.query("unguard").then(() => true, () => false), STOP_TIMEOUT_MS, false);
    return answered;
  }

  async function arm(s: Session): Promise<void> {
    // Never a second arm while one is pending (the actor would leave the first unanswered).
    if (s.armed) return;
    const g = ++s.generation;
    s.sameDocument = false;
    if (pageOf(s.browser) !== s.wgp) return service.stop(s.target);
    s.armed = true;
    clearTimeout(s.unguardTimer);
    // An arm on a home that is removed never answers: left pending, the session is gone by then (stopped on onState).
    const answer = s.query("arm", { code: firefoxViewfinderScript() }).catch(() => null);
    // The home's subframes share its process, behind its top's guard (and have no RessacDesignFrames actor).
    if (!s.home) for (const bc of s.browser.browsingContext.getAllBrowsingContextsInSubtree()) guardFrame(s, bc.currentWindowGlobal);
    const r = await answer;
    // A stale answer: whoever made it stale (stop, forget) has unguarded the frames.
    if (!current(s, g)) return;
    s.armed = false;
    if (!r) {
      unguardFrames(s);
      // A same-document navigation stopped the viewfinder: armed again, the mode stays. Else Escape, page gone: it stops.
      return s.sameDocument ? arm(s) : service.stop(s.target);
    }
    s.unguardTimer = setTimeout(() => s.armed || unguardFrames(s), SWALLOW_MS);
    const capture = cleanCapture(r);
    if (!capture) return service.stop(s.target);
    // A site app's pages: nothing is read in the page's world, the source stays unknown. Its home is the agent's code: read.
    const site = s.target.type === "site" && !s.home;
    const source = site ? null : cleanSource(await within(s.query("source", { code: sourceExpression(capture.selector) }).catch(() => null), SOURCE_TIMEOUT_MS, null));
    if (!current(s, g)) return;
    if (pageOf(s.browser) !== s.wgp) return service.stop(s.target);
    const png = await capturePng(s.browser, capture.rect, capture.view, s.wgp);
    if (!current(s, g)) return;
    const { rect, ...context } = capture;
    // The home's address as the kernel knows it (no served copy's token): it tags such remarks [accueil] (pty/context.ts).
    if (s.home && s.target.type === "site") context.url = `ressac-site://${s.target.id}${new URL(context.url).pathname.replace(/^\/sites\/[^/]+/, "")}`;
    s.pending = { context: { ...context, source }, capture: png };
    const v = view(s.target);
    if (v?.browser !== s.browser || pageOf(s.browser) !== s.wgp || s.win.closed) return service.stop(s.target);
    const b = s.target.type === "site" ? o.sites.designView(s.target.id)?.bounds : s.browser.getBoundingClientRect();
    if (!b) return service.stop(s.target);
    const bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    const win: [number, number] = [s.win.innerWidth, s.win.innerHeight];
    const place = bubbleSlot(rect, s.browser.fullZoom ?? 1, bounds, win, site ? { minHeight: bounds.y, height: SITE_BUBBLE_SIZE.height } : s.home ? { minHeight: bounds.y } : {});
    show(s.key, s.win, place, { mode: "bubble", message: null, project: s.project.project, label: context.label, source: sourceText(source), ...s.destination, warning: site ? format(o.locale(), "chrome-design-capture-warning") : null });
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
      if (key.startsWith("app:") && !o.apps.viewFor(key.slice(4))) service.forget({ type: "app", folder: key.slice(4) });
  });
  o.sites.onClosed(() => {
    for (const key of new Set([...sessions.keys(), ...contexts.keys()]))
      if (key.startsWith("site:") && !o.sites.designView(key.slice(5))) service.forget({ type: "site", id: key.slice(5) });
  });

  const service: DesignService = {
    overlays: { show() {}, hide() {}, forget() {}, onColumnClosed: () => () => {} },

    async state(t) {
      const s = sessions.get(targetKey(t));
      const v = s ? null : view(t);
      // A host that does not answer rejects: the button keeps its last state.
      const r = s ? await o.agent.request<DesignTracking | null>("design.tracking", { project: s.project.project }) : v ? await tracking(t, v) : null;
      const project = r?.project ?? s?.project ?? null;
      if (!project) return { active: false, project: null, unavailable: t.type === "site" ? UNAVAIL_SITE() : UNAVAIL(), destination: null, noDestination: null, basket: 0, name: "", shortcut: o.shortcutLabel() };
      // A site app: its project is known even where the mode does not start (card, sign-in page, fullscreen).
      const unavailable = t.type === "site" && !s && !o.sites.designView(t.id)?.available ? UNAVAIL_SITE() : null;
      return { active: !!s, project: project, unavailable: unavailable, destination: r?.destination ?? null, noDestination: r?.noDestination ?? null, basket: r?.basket ?? 0, name: r?.name ?? "", shortcut: o.shortcutLabel() };
    },

    async toggle(t) {
      const key = targetKey(t);
      if (sessions.has(key)) return service.stop(t);
      if (!o.labOn()) return asleep(t.type === "window" ? t.windowId : undefined);
      const site = t.type === "site" ? o.sites.designView(t.id) : null;
      // Unavailable in the site app's window: why, in its bar; nothing injected.
      if (t.type === "site" && !site?.available) return o.sites.infoNotice(t.id, UNAVAIL_SITE());
      const v = view(t);
      if (!v) return;
      // The page whose address gives the project, read with the address: the only one ever armed.
      const wgp = pageOf(v.browser);
      const r = await tracking(t, v, wgp).catch(() => undefined);
      // A site app's view may have changed during the host's answer (⌂, fullscreen, a sign-in page): read again.
      if (t.type === "site" && r && !sessions.has(key)) {
        const now = o.sites.designView(t.id);
        if (!now?.available) return o.sites.infoNotice(t.id, UNAVAIL_SITE());
        if (now.viewState !== site!.viewState) return;
      }
      if (!r || !wgp || sessions.has(key) || view(t)?.browser !== v.browser || pageOf(v.browser) !== wgp) {
        // A tab outside the followed projects (the host said so): why nothing happens, nothing injected.
        if (r === null && t.type === "window" && !sessions.has(key) && view(t)?.browser === v.browser) {
          const b = v.browser.getBoundingClientRect();
          const place = { x: b.x + b.width - MESSAGE_MARGIN - MESSAGE_WIDTH, y: b.y + MESSAGE_MARGIN, width: MESSAGE_WIDTH, height: MESSAGE_HEIGHT };
          show(key, v.win, place, { mode: "message", message: UNAVAIL(), project: "", label: "", source: null, destination: null, noDestination: null, warning: null });
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
          s.sameDocument = true;
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
          ? o.sites.controller(t.id)?.onState((e) => (e.viewState !== site.viewState || win.document.documentElement.hasAttribute("inDOMFullscreen")) && off())
          : undefined;
      gBrowser.addTabsProgressListener(progress);
      gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
      gBrowser.tabContainer.addEventListener("TabClose", onClose);
      // Window capture: before tabs.ts's handler, which stops it at the tab panels.
      win.addEventListener("oop-browser-crashed", onCrash, true);
      win.addEventListener("unload", onUnload);
      const home = t.type === "site" && browser === site?.home;
      const s: Session = {
        query: home ? (name, data) => ask(wgp, name, { ...data, home: `${framesOrigin()}/sites/` }, HOME_ACTOR) : (name, data) => ask(wgp, name, data), home,
        target: t, key, project: r.project, browser, win, wgp, generation: 0, sameDocument: false, armed: false, pending: null,
        destination: { destination: r.destination, noDestination: r.noDestination }, guarded: new Set(), unguardTimer: undefined,
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
      const windowId = (win as any).ressacWindow?.windowId as WindowId | undefined;
      const main = !!windowId && o.windows.get(windowId)?.window === win;
      if (!o.labOn()) return void asleep(main ? windowId : undefined);
      const app = o.apps.folderOf(win);
      const choice = chooseDesignTarget({
        app: app,
        site: doc.getAttribute("ressac-site") ?? undefined,
        siteSmall: doc.getAttribute("ressac-site-small") ?? undefined,
        otherWindow: !main && !app,
        activeWindow: main ? windowId : undefined,
      });
      if (choice.type === "site-notice") o.sites.infoNotice(choice.id, UNAVAIL_SITE());
      else if (choice.type === "target") void service.toggle(choice.target);
    },

    async stop(t) {
      const s = sessions.get(targetKey(t));
      if (!s) return;
      sessions.delete(s.key);
      s.generation++;
      s.pending = null;
      s.armed = false;
      s.cleanup();
      unguardFrames(s);
      hide(s.key, "bubble");
      notify();
      await disarm(s);
    },

    async stopAll() {
      await Promise.all([...sessions.values()].map((s) => service.stop(s.target)));
    },

    async add(t, text) {
      const s = sessions.get(targetKey(t));
      const waiting = s?.pending;
      if (!s || !waiting) return { ok: false, error: NOTHING_AIMED };
      let r: ExtensionResult;
      try {
        r = await o.agent.request<ExtensionResult>("design.add", { project: s.project.project, text: text, context: waiting.context, capture: waiting.capture });
      } catch (e) {
        // Spec §5.10: the call's error, the mode stays.
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (!r.ok || sessions.get(s.key) !== s || s.pending !== waiting) return r;
      s.pending = null;
      hide(s.key, "bubble");
      giveKeyboard(s);
      void armSafe(s);
      return r;
    },

    cancel(t) {
      const key = targetKey(t);
      const s = sessions.get(key);
      if (!s?.pending) {
        hide(key, "message");
        return hide(key, "basket");
      }
      s.pending = null;
      hide(key, "bubble");
      giveKeyboard(s);
      void armSafe(s);
    },

    async openCart(t) {
      const n = askCart(targetKey(t));
      const v = view(t);
      const r = v ? await tracking(t, v).catch(() => null) : null;
      if (!v || !r || cartAsks.get(targetKey(t)) !== n) return;
      const [l, h] = [v.win.innerWidth, v.win.innerHeight];
      // A site app's cart starts under its bar.
      const y = t.type === "site" ? SITE_BAR_HEIGHT + MARGIN : MARGIN;
      const place = { x: Math.max(0, l - MARGIN - BASKET_WIDTH), y, width: Math.min(BASKET_WIDTH, l), height: Math.max(0, h - y - MARGIN) };
      show(targetKey(t), v.win, place, { mode: "basket", message: null, project: r.project.project, label: "", source: null, destination: r.destination, noDestination: r.noDestination, warning: null });
    },

    async review(t) {
      const v = view(t);
      const r = v ? await tracking(t, v).catch(() => null) : null;
      if (!r || r.project.type === "demo") return;
      const windowId = t.type === "window" ? t.windowId : await o.mainWindow();
      if (!windowId) return;
      o.dispatch({ type: "openReview", windowId: windowId, project: r.project.project, name: r.name.slice(0, 80) });
      if (t.type !== "window") o.toFront(windowId);
    },

    overlayContext(t, modes = ["bubble", "basket", "message"]) {
      const c = contexts.get(targetKey(t));
      for (const mode of modes) if (c?.[mode]) return c[mode];
      return null;
    },

    closeOverlay(t, mode) {
      const key = targetKey(t);
      if (mode === "basket") askCart(key);
      hide(key, mode);
    },

    forget(t) {
      const key = targetKey(t);
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
    refresh: notify,
  };
  return service;
}

/**
 * An overlay frame's OverlayApi: its target is the chrome's, never an id the frame sends.
 * A project is allowed only if it is the one the overlay shows (projetPermis); the host checks every bound again.
 * `modes`: what this frame shows. `cancel`: the frame's own (the cart column's « Fermer »), else the service's cancel.
 */
// Trust boundary: the frame is a system-principal chrome document, so it could reach the chrome itself; this API is a
// convention for the UI, and the real guards are these chrome-side checks and the host's.
export function overlayApi(
  o: { design: DesignService; host: Pick<AgentHost, "request" | "on">; modes?: OverlayContext["mode"][]; cancel?: () => void },
  t: DesignTarget,
): OverlayApi {
  const allowed = (p: unknown): p is string => typeof p === "string" && ID_PROJECT.test(p) && o.design.overlayContext(t)?.project === p;
  const id = (x: unknown): x is string => typeof x === "string" && x.length <= DESIGN_ID_MAX;
  // Spec §5.10, the host stopped: DesignBasket reads again after a failed send and would show a rejected read as an
  // empty cart. The last answer stands instead; a restarted host is read again (surChange).
  const last = new Map<string, unknown>();
  const read = <T>(method: string, p: string): Promise<T> =>
    o.host.request<T>(method, { project: p }).then(
      (v) => (last.set(`${method} ${p}`, v), v),
      (e) => (last.has(`${method} ${p}`) ? (last.get(`${method} ${p}`) as T) : Promise.reject(e)),
    );
  return {
    context: async () => o.design.overlayContext(t, o.modes),
    async add(text) {
      if (typeof text !== "string" || text.length > REMARK_TEXT_MAX) return { ok: false, error: INVALID_REQUEST };
      return o.design.add(t, text);
    },
    cancel: () => (o.cancel ? o.cancel() : o.design.cancel(t)),
    basket: async (p) => (allowed(p) ? read<ShownElement[]>("design.basket", p) : []),
    batches: async (p) => (allowed(p) ? read<BatchShown[]>("design.batches", p) : []),
    async remove(p, x) {
      if (allowed(p) && id(x)) await o.host.request("design.remove", { project: p, id: x });
    },
    async handled(p, batch) {
      if (allowed(p) && id(batch)) await o.host.request("design.handled", { project: p, batch: batch });
    },
    send: async (p) => (allowed(p) ? o.host.request<ExtensionResult>("design.send", { project: p }) : { ok: false, error: INVALID_REQUEST }),
    onChange(cb) {
      // accueil.change: sent at each kernel start (host/host.ts), so a restarted host's cart is read again.
      const offs = [...["design.change", "home.change"].map((m) => o.host.on(m, () => cb())), o.design.onChange(cb)];
      return () => offs.forEach((f) => f());
    },
  };
}
