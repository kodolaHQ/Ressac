import type { HideApi, HideContext, HideRect } from "../../shared/api";
import { auraVariables, DEFAULT_AURA } from "../../shared/aura";
import { format } from "../../shared/i18n";
import { siteOf, tabProfile, type TabId, type WindowId } from "../../shared/model";
import { tabInfos } from "../../core/agent/bridge";
import { cleanOrigin, FIELD_LABEL, PASSPORT_FIELDS, PASSPORT_LIMITS, splitName, type MaskedRun, type PassportField } from "../shims/kernel";
import type { RessacHideParent } from "../agent/hide-actor";
import type { RessacStore } from "../store";
import { cutFrameNetwork } from "./frame-network";

// « Cacher pour l'agent »: the user points at a value on the page, confirms it in a bubble, and it becomes a passport
// entry. Two frames of sidebar.html over the content area, drawn by Ressac and never in the page: the layer (outline,
// animation, ending; it captures the pointer only while picking, so the page sees no move) and the bubble frame
// (bubble, error, toast). Every decision is here; the frames only show `HideContext` and press its gesture endpoints.

const XHTML = "http://www.w3.org/1999/xhtml";
const SRC = "chrome://browser/content/ressac/sidebar.html?";
/** The toast's « Annuler »: after it, an undo does nothing (measured here, never by a frame). */
export const UNDO_MS = 8000;
const BUBBLE_WIDTH = 340;
/** The toast frame's width (ui/HideApp.svelte's .toast-root): the toast is centred in it. */
const TOAST_WIDTH = 420;
/** Room the bubble needs under its target before it goes above. */
const BUBBLE_ROOM = 240;
/** The frames' exit fades (150 ms) play before they leave. */
const EXIT_MS = 200;
/** A snapshot larger than this (CSS px²) is not taken: the animation then has no pixels, only the shimmer. */
const SNAPSHOT_MAX = 2_000_000;

type Frame = HTMLIFrameElement & { ressacHide?: { api: HideApi } };
type Got = { text: string; rect: HideRect; origin: string | null };

/**
 * The honest ending: what is true now. A tab the agent reached never gets its site; otherwise the value is hidden here
 * only when the kernel's runs over the frozen text cover all of it (the site was already a source of this conversation).
 */
export function ending(o: { agentReached: boolean; runs: MaskedRun[]; length: number }): "hidden" | "next" | "agentReached" {
  if (o.agentReached) return "agentReached";
  let covered = 0;
  for (const r of [...o.runs].sort((a, b) => a.start - b.start)) {
    if (r.start > covered) break;
    covered = Math.max(covered, r.end);
  }
  return o.length > 0 && covered >= o.length ? "hidden" : "next";
}

/** The bubble's text: start…end past `max` characters (the whole text is kept and saved). */
export function shorten(text: string, max = 60): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

const scaled = (r: HideRect, z: number): HideRect => ({ x: r.x * z, y: r.y * z, width: r.width * z, height: r.height * z });

export interface HideControl {
  /** The toolbar button: arms the viewfinder, or leaves it on a second press. */
  toggle(): void;
  picking(): boolean;
  onChange(cb: () => void): () => void;
}

export function mountHideLayer(win: Window, store: RessacStore, windowId: WindowId): HideControl & { dispose(): void } {
  const doc = win.document as Document & { createXULElement(tag: string): Element };
  let ctx: HideContext | null = null;
  /** What the bubble's « Cacher » saves: frozen at the pick. */
  let pick: { tab: TabId; browser: any; text: string; origin: string | null; agentReached: boolean; profile: string } | null = null;
  /** The last hide, for the toast's « Annuler » until `until`. */
  let saved: { profile: string; id: string; created: boolean; addedOrigin: boolean; updated: string; origin: string | null; until: number } | null = null;
  /** Each arm or close: an answer that comes back after it is dropped. */
  let gen = 0;
  let seq = 0;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  let layer: Frame | undefined;
  let bubble: Frame | undefined;

  const locale = () => store.state.locale;
  const activeTab = (): TabId | undefined => {
    const f = store.state.windows.find((x) => x.id === windowId);
    return f?.active[f.activeSpace] ?? undefined;
  };
  const selected = () => win.gBrowser.selectedBrowser;
  const webPage = (b: any) => {
    const s = b?.currentURI;
    return !!s && (s.schemeIs("http") || s.schemeIs("https"));
  };
  const actorOf = (wg: any): RessacHideParent | null => {
    try {
      return wg?.getActor("RessacHide") ?? null;
    } catch {
      return null; // not an http(s) document
    }
  };
  const aura = () => {
    const f = store.state.windows.find((x) => x.id === windowId);
    return auraVariables(store.state.spaces.find((s) => s.id === f?.activeSpace)?.aura ?? DEFAULT_AURA);
  };

  const api: HideApi = {
    context: () => ctx,
    confirm,
    cancel: () => close(),
    undo,
    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };

  function frame(id: string, query: string): Frame {
    const f = doc.createElementNS(XHTML, "iframe") as Frame;
    f.id = id;
    // Out of the flow before it is appended (spike S8), and click-through until a phase needs it.
    f.style.cssText = "position: fixed; z-index: 3; border: 0; background: transparent; display: none; pointer-events: none";
    doc.getElementById("browser")!.append(f);
    const mayLoad = cutFrameNetwork(f);
    f.ressacHide = { api };
    // Capture: measured, a chrome iframe's load reaches only a capturing listener; its document's own loads (the
    // snapshot image) come this way too, so each document is set up once.
    const seen = new WeakSet<Document>();
    f.addEventListener("load", () => {
      const w = f.contentWindow;
      if (!w || !w.location.href.startsWith("chrome:") || seen.has(w.document)) return;
      seen.add(w.document);
      for (const [k, v] of Object.entries(aura())) w.document.documentElement.style.setProperty(k, v);
      if (f === layer) listen(w);
      else if (ctx && ctx.phase !== "pick") f.focus();
    }, true);
    if (mayLoad) f.src = SRC + query;
    return f;
  }
  const frames = () => {
    if (!layer?.isConnected) layer = frame("ressac-hide-layer", "hide");
    if (!bubble?.isConnected) bubble = frame("ressac-hide-bubble", "hide-bubble");
  };

  /** Both frames where the phase puts them; they leave after their exit fade. */
  function layout() {
    if (!layer || !bubble) return;
    clearTimeout(exitTimer);
    if (!ctx) {
      layer.style.pointerEvents = bubble.style.pointerEvents = "none";
      exitTimer = setTimeout(() => {
        if (!ctx && layer && bubble) layer.style.display = bubble.style.display = "none";
      }, EXIT_MS);
      return;
    }
    const a = selected().getBoundingClientRect();
    Object.assign(layer.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px`, display: "", pointerEvents: ctx.phase === "pick" ? "auto" : "none" });
    if (ctx.phase === "pick") return void (bubble.style.display = "none");
    if (ctx.phase === "toast") {
      // Centred by its fixed width, never a transform: a transformed frame gets its clicks at the wrong place.
      Object.assign(bubble.style, { display: "", pointerEvents: "", left: `${a.left + (a.width - TOAST_WIDTH) / 2}px`, top: "", bottom: `${win.innerHeight - a.bottom + 16}px` });
      return;
    }
    const t = ctx.target ?? { x: 16, y: 16, width: 0, height: 0 };
    const left = Math.max(a.left + 8, Math.min(a.left + t.x, a.right - BUBBLE_WIDTH - 8));
    const below = a.top + t.y + t.height + 8;
    const place = below + BUBBLE_ROOM <= a.bottom ? { top: `${below}px`, bottom: "" } : { top: "", bottom: `${win.innerHeight - Math.max(a.top + 8, a.top + t.y - 8)}px` };
    Object.assign(bubble.style, { display: "", pointerEvents: "", left: `${left}px`, ...place });
  }

  function changed() {
    layout();
    for (const cb of listeners)
      try {
        cb();
      } catch (e) {
        console.error("[hide] listener failed:", e);
      }
  }
  const set = (c: HideContext | null) => {
    ctx = c;
    changed();
  };

  function close() {
    gen++;
    pick = saved = null;
    clearTimeout(toastTimer);
    const ours = doc.activeElement === layer || doc.activeElement === bubble;
    set(null);
    if (ours && webPage(selected())) selected().focus();
  }

  function arm() {
    close();
    if (!webPage(selected())) return;
    frames();
    gen++;
    set({ phase: "pick", text: "", short: "", site: null, field: "libre", seq, locale: locale() });
    layer!.focus();
  }

  // The pointer while picking, in the layer frame's CSS px (the content area's): the actor wants the page's, unzoomed.
  let hovering = false;
  let nextHover: [number, number] | null = null;
  async function hover(x: number, y: number) {
    nextHover = [x, y];
    if (hovering) return;
    hovering = true;
    try {
      // One query in flight, then the latest point: hoverAt runs the whole pick.
      while (nextHover && ctx?.phase === "pick") {
        const [hx, hy] = nextHover;
        nextHover = null;
        const b = selected();
        const z = b.fullZoom || 1;
        const r = await actorOf(b.browsingContext?.currentWindowGlobal)?.at("hoverAt", hx / z, hy / z).catch(() => null);
        if (ctx?.phase === "pick") set({ ...ctx, hover: r ? scaled(r.rect, z) : undefined });
      }
    } finally {
      hovering = false;
    }
  }
  async function pickAt(x: number, y: number) {
    const b = selected();
    const z = b.fullZoom || 1;
    const g = gen;
    const r = await actorOf(b.browsingContext?.currentWindowGlobal)?.at("pickAt", x / z, y / z).catch(() => null);
    if (g !== gen || ctx?.phase !== "pick" || !r) return;
    await open(b, { text: r.text, rect: scaled(r.rect, z), origin: r.origin });
  }
  function listen(w: Window) {
    w.addEventListener("mousemove", (e) => ctx?.phase === "pick" && void hover(e.clientX, e.clientY));
    w.addEventListener("click", (e) => {
      if (ctx?.phase !== "pick" || e.button !== 0) return;
      e.preventDefault();
      void pickAt(e.clientX, e.clientY);
    });
    w.addEventListener("keydown", onKey, true);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || ctx?.phase !== "pick") return;
    e.preventDefault();
    close();
  }
  // The page may have the keyboard while picking (the toolbar button gave the layer focus, but a frame may not be loaded yet).
  win.addEventListener("keydown", onKey, true);

  /** The target's pixels for the animation, drawn by the parent (the page draws nothing), and its corner's colour. */
  async function snapshot(b: any, r: HideRect, z: number): Promise<HideContext["snapshot"]> {
    if (r.width < 1 || r.height < 1 || r.width * r.height > SNAPSHOT_MAX) return undefined;
    const bitmap = await b.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(r.x / z, r.y / z, r.width / z, r.height / z), z * win.devicePixelRatio, "white", { drawView: true });
    try {
      const canvas = doc.createElementNS(XHTML, "canvas") as HTMLCanvasElement;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const g = canvas.getContext("2d")!;
      g.drawImage(bitmap, 0, 0);
      const [red, green, blue] = g.getImageData(0, 0, 1, 1).data;
      return { url: canvas.toDataURL("image/png"), background: `rgb(${red}, ${green}, ${blue})` };
    } finally {
      bitmap.close();
    }
  }

  /** The bubble on a frozen text: its type guessed by the kernel, its site unless the agent reached the tab (unknown = reached). */
  async function open(b: any, got: Got) {
    const tabId = activeTab();
    const tab = tabId ? store.state.tabs[tabId] : undefined;
    if (!tabId || !tab || b !== selected()) return close();
    frames();
    const g = ++gen;
    const info = tabInfos(store.state).find((t) => t.id === tabId);
    const agentReached = info?.agentReached ?? true;
    // A page without a host to keep (a file, an opaque frame) hides the value without a site, as `hide` does.
    const origin = agentReached || got.origin === null || cleanOrigin(got.origin) === null ? null : got.origin;
    const long = got.text.length > PASSPORT_LIMITS.value;
    const z = b.fullZoom || 1;
    const [guess, snap] = await Promise.all([
      long ? { field: "libre" as const } : store.agent.request<{ field: PassportField; name?: { given: string; family: string } }>("mask.guess", { text: got.text }).catch(() => ({ field: "libre" as const })),
      snapshot(b, got.rect, z).catch(() => undefined),
    ]);
    if (g !== gen) return;
    pick = { tab: tabId, browser: b, text: got.text, origin, agentReached, profile: info?.profile ?? tabProfile(store.state, tab) };
    delete layer!.dataset.ending;
    set({
      phase: long ? "error" : "bubble",
      ...(long ? { error: "long" as const } : {}),
      text: got.text,
      short: shorten(got.text),
      site: origin ? siteOf(origin) : null,
      field: guess.field,
      // The Prénom(s) / Nom fields, for a name or a type changed to one.
      ...(long ? {} : { name: "name" in guess && guess.name ? guess.name : splitName(got.text) }),
      target: got.rect,
      ...(snap ? { snapshot: snap } : {}),
      seq,
      locale: locale(),
    });
    bubble!.focus();
  }

  async function confirm(choice: { field: PassportField; name?: { given: string; family: string } }) {
    const p = pick;
    if (ctx?.phase !== "bubble" || !p || !PASSPORT_FIELDS.includes(choice?.field)) return;
    const named = choice.field === "nom" || choice.field === "proche";
    const n = choice.name;
    if (named && (typeof n?.given !== "string" || typeof n.family !== "string")) return;
    const g = gen;
    set({ ...ctx, phase: "saving", field: choice.field, ...(n ? { name: { given: n.given, family: n.family } } : {}), error: undefined });
    const r = await store.hidePassport.hide({
      profile: p.profile,
      field: choice.field,
      value: named ? { given: n!.given, family: n!.family } : { text: p.text },
      origin: p.origin,
      reason: format(locale(), "chrome-hide-reauth"),
    });
    if (g !== gen || !ctx) return;
    if (!r.ok) {
      if (r.error === "cancelled") return close();
      return set({ ...ctx, phase: r.error === "invalid" ? "bubble" : "error", error: r.error });
    }
    // The ending asks the kernel about the page as it is now (its url, whether the agent reached it since).
    const reachedNow = tabInfos(store.state).find((t) => t.id === p.tab)?.agentReached ?? true;
    const url = String(p.browser.currentURI?.spec ?? store.state.tabs[p.tab]?.url ?? "");
    const runs = await store.agent
      .request<{ runs: MaskedRun[][] }>("mask.runs", { window: windowId, tab: p.tab, url, agentReached: reachedNow, texts: [p.text] })
      .then((x) => x.runs[0] ?? [], () => []);
    if (g !== gen || !ctx) return;
    const end = ending({ agentReached: p.agentReached || reachedNow, runs, length: p.text.length });
    const undoable = r.created || r.addedOrigin;
    saved = undoable ? { profile: p.profile, id: r.id, created: r.created, addedOrigin: r.addedOrigin, updated: r.updated, origin: p.origin, until: Date.now() + UNDO_MS } : null;
    pick = null;
    // The e2e read the ending here: the chip's sentence lasts 2.5 s.
    layer!.dataset.ending = end;
    set({ ...ctx, phase: "toast", ending: end, undoable, readBefore: !!store.access.tabs[p.tab]?.read, chip: `⟨${FIELD_LABEL[choice.field]}-…⟩`, hover: undefined, seq: ++seq });
    toastTimer = setTimeout(close, UNDO_MS);
  }

  async function undo() {
    const s = saved;
    if (!s || Date.now() > s.until) return;
    saved = null;
    const g = gen;
    const ok = await store.hidePassport.unhide(s);
    if (g !== gen) return;
    if (ok || !ctx) return close();
    clearTimeout(toastTimer);
    set({ ...ctx, phase: "error", error: "write" });
  }

  // The content-area context menu: on a selection, or on an element (the pick at the menu's point).
  const menu = doc.getElementById("contentAreaContextMenu");
  const item = doc.createXULElement("menuitem");
  item.id = "ressac-context-hide";
  let facts: { browser: any; bc: any; selected: boolean; x: number; y: number } | null = null;
  const onMenu = (e: Event) => {
    if (e.target !== menu) return;
    const cm = (win as any).gContextMenu;
    item.setAttribute("label", format(locale(), "chrome-hide"));
    const c = cm?.contentData?.context;
    const on = !!cm && webPage(cm.browser) && cm.browser === selected() && (cm.isTextSelected || !(cm.onTextInput || cm.onImage || cm.onVideo || cm.onAudio || cm.onCanvas));
    facts = on ? { browser: cm.browser, bc: cm.frameBrowsingContext ?? cm.browser.browsingContext, selected: !!cm.isTextSelected, x: Number(c?.clientX), y: Number(c?.clientY) } : null;
    (item as any).hidden = !on;
  };
  const onCommand = async () => {
    const f = facts;
    if (!f || f.browser !== selected()) return;
    close();
    const g = gen;
    const top = actorOf(f.browser.browsingContext?.currentWindowGlobal);
    const own = actorOf(f.bc?.currentWindowGlobal);
    // A frame's answers are in its own viewport: shifted by its place in the top window.
    const offset = own ? await (own.constructor as typeof RessacHideParent).offsetOf(f.bc).catch(() => null) : null;
    if (!top || !own || !offset) return;
    let got: Got | null = null;
    if (f.selected) {
      const s = await own.selection();
      got = s && { ...s, rect: { ...s.rect, x: s.rect.x + offset.x, y: s.rect.y + offset.y } };
    } else if (Number.isFinite(f.x) && Number.isFinite(f.y)) got = await top.at("pickAt", f.x + offset.x, f.y + offset.y);
    if (!got || g !== gen) return;
    const z = f.browser.fullZoom || 1;
    await open(f.browser, { ...got, rect: scaled(got.rect, z) });
  };
  if (menu) {
    menu.prepend(item);
    menu.addEventListener("popupshowing", onMenu);
    item.addEventListener("command", () => void onCommand());
  }

  // A tab switch ends the gesture; so does the page leaving while the viewfinder is armed (its outline is stale).
  let shown = activeTab();
  let shownUrl = shown ? store.state.tabs[shown]?.url : undefined;
  const offStore = store.subscribe((state) => {
    const id = activeTab();
    const url = id ? state.tabs[id]?.url : undefined;
    const moved = id !== shown || (ctx?.phase === "pick" && url !== shownUrl);
    shown = id;
    shownUrl = url;
    if (moved && ctx) close();
  });
  const onResize = () => ctx && layout();
  win.addEventListener("resize", onResize);

  return {
    toggle: () => (ctx?.phase === "pick" ? close() : arm()),
    picking: () => ctx?.phase === "pick",
    onChange: api.onChange,
    dispose() {
      gen++;
      clearTimeout(toastTimer);
      clearTimeout(exitTimer);
      offStore();
      win.removeEventListener("keydown", onKey, true);
      win.removeEventListener("resize", onResize);
      menu?.removeEventListener("popupshowing", onMenu);
      item.remove();
      layer?.remove();
      bubble?.remove();
      listeners.clear();
    },
  };
}
