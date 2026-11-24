import type { HideApi, HideContext, HideRect, MarksApi } from "../../shared/api";
import { auraVariables, DEFAULT_AURA, type AuraId } from "../../shared/aura";
import { format } from "../../shared/i18n";
import { siteOf, tabProfile, type TabId, type WindowId } from "../../shared/model";
import { tabInfos } from "../../core/agent/bridge";
import { joinPieces, runsToPieces } from "../../core/hide/text-map";
import { commonRuns, createMarks, MARKS_EVERY_MS } from "../../core/hide/marks";
import { cleanOrigin, FIELD_LABEL, originMatches, PASSPORT_FIELDS, PASSPORT_LIMITS, splitName, type MaskedRun, type PassportField } from "../shims/kernel";
import type { RessacHideParent } from "../agent/hide-actor";
import type { HideResult } from "../passport/settings";
import type { RessacStore } from "../store";
import { cutFrameNetwork } from "./frame-network";

// « Cacher pour l'agent »: the user points at a value on the page, confirms it in a bubble, and it becomes a passport
// entry. Two frames of sidebar.html over the content area, drawn by Ressac and never in the page: the layer (outline,
// animation, ending; it captures the pointer from the arm until the toast, so the page sees no move, not even the
// pointer resting over the value while the bubble is up) and the bubble frame (bubble, error, toast), above it. Every decision
// is here; the frames only show `HideContext` and press its gesture endpoints.

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
/** `origin`: the top document's, from the parent (RessacHideParent.origin), whichever frame the text is in. */
type Got = { text: string; rect: HideRect; origin: string | null };

export type Ending = NonNullable<HideContext["ending"]>;

type Run = { start: number; end: number };

/** Whether the runs together cover [from, to) (an empty span is not covered). */
function covers(runs: Run[], from: number, to: number): boolean {
  let covered = from;
  for (const r of [...runs].sort((a, b) => a.start - b.start)) {
    if (r.start > covered) break;
    covered = Math.max(covered, r.end);
  }
  return to > from && covered >= to;
}

/**
 * The honest ending: what is true now. A tab the agent reached never gets its site. Otherwise the value is hidden
 * here when the kernel's runs cover all of the trimmed value (`length`) and the page as the agent reads it masks it
 * too (`onPage`, maskedOnPage); masked alone but not on the page (glued to a neighbour), it is not masked here; else
 * it is hidden here from the next conversation when the entry has the page's site (`siteMatches`: added or already
 * there, and matching the top URL) and the next conversation's table masks it on the page (`nextOnPage`); otherwise it
 * is in the passport but not masked on this page (glued, or an http page: the passport's sites are https only).
 */
export function ending(o: { agentReached: boolean; runs: Run[]; length: number; siteMatches: boolean; onPage?: boolean; nextOnPage?: boolean }): Ending {
  if (o.agentReached) return "agentReached";
  if (covers(o.runs, 0, o.length)) return o.onPage === false ? "notHere" : "hidden";
  return o.siteMatches && o.nextOnPage !== false ? "next" : "notHere";
}

/**
 * Whether the agent reads `value` masked on this page: each document's text (joined as the marks join it) with what
 * every token masks in it (runsForAll). Every occurrence of the value, case and spacing aside, must be covered, up to
 * its `@` for an e-mail. No occurrence (the page glues it to a neighbour, or changed): false, fail closed.
 */
export function maskedOnPage(docs: { text: string; runs: Run[] }[], value: string, field: PassportField): boolean {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "gi");
  let seen = false;
  for (const d of docs)
    for (const m of d.text.matchAll(re)) {
      seen = true;
      if (!covers(d.runs, m.index, m.index + coverLength(field, m[0]))) return false;
    }
  return seen;
}

/**
 * Fail closed: a site the hide added while the agent reached the tab (during the bubble or Touch ID) is taken back
 * (`takeBack`), so the passport holds what the toast says. Taken back: no site added; not: a write error.
 */
export async function settleSite(r: HideResult, reached: boolean, takeBack: () => Promise<boolean>): Promise<HideResult> {
  if (!r.ok || !r.addedOrigin || !reached) return r;
  return (await takeBack()) ? { ...r, addedOrigin: false } : { ok: false, error: "write" };
}

/**
 * What every token masks in `text` of tab `tab` (commonRuns): mask.runs asked for each window, null (no session) left
 * out, and always for the main token (`window: null`), whose tools need no conversation. A failed or malformed answer
 * masks nothing (fail closed). The marks and the ending use this one rule: a tab's tool may come from any token.
 */
export async function runsForAll(request: (method: string, params: unknown) => Promise<unknown>, windows: string[], p: { tab: string; url: string; agentReached: boolean; text: string }): Promise<Run[]> {
  const ask = (window: string | null) =>
    request("mask.runs", { window, tab: p.tab, url: p.url, agentReached: p.agentReached, texts: [p.text] }).then(
      (x) => {
        const runs = (x as { runs?: unknown } | null)?.runs;
        return Array.isArray(runs) ? (Array.isArray(runs[0]) ? (runs[0] as MaskedRun[]) : []) : runs === null && window !== null ? null : [];
      },
      () => [],
    );
  return commonRuns(await Promise.all([ask(null), ...windows.map(ask)]));
}

/**
 * How much of the trimmed `value` the runs must cover for `hidden`: all of it, but for an e-mail only its local part
 * (the kernel masks what comes before the `@`, the domain stays readable).
 */
export function coverLength(field: PassportField, value: string): number {
  const at = value.indexOf("@");
  return field === "email" && at > 0 ? at : value.length;
}

/** The toast's « Annuler » window, on an injectable clock: what `open` keeps, `take` gives once, within `ms`. */
export function undoWindow<T>(ms = UNDO_MS, now: () => number = Date.now) {
  let kept: { value: T; until: number } | null = null;
  return {
    open: (value: T) => void (kept = { value, until: now() + ms }),
    clear: () => void (kept = null),
    take(): T | null {
      const k = kept;
      kept = null;
      return k && now() <= k.until ? k.value : null;
    },
  };
}

/** The bubble's text: start…end past `max` characters (the whole text is kept and saved). */
export function shorten(text: string, max = 60): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};
const scaled = (r: HideRect, z: number): HideRect => ({ ...r, x: r.x * z, y: r.y * z, width: r.width * z, height: r.height * z });
// The same helper as hide-actor.ts's, not imported: that module is the actor's own bundle (a value import would pull it
// into the window's).
const actorOf = (wg: any): RessacHideParent | null => {
  try {
    return wg?.getActor("RessacHide") ?? null;
  } catch {
    return null; // not an http(s) document
  }
};

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
  /** The last hide, for the toast's « Annuler » within UNDO_MS. */
  const saved = undoWindow<{ profile: string; id: string; created: boolean; addedOrigin: boolean; updated: string; origin: string | null }>();
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
  const aura = () => {
    const f = store.state.windows.find((x) => x.id === windowId);
    return auraVariables(store.state.spaces.find((s) => s.id === f?.activeSpace)?.aura ?? DEFAULT_AURA);
  };

  const api: HideApi = {
    context: () => ctx,
    confirm,
    // The save in flight always reaches its toast (or its error): no cancel while saving.
    cancel: () => void (ctx?.phase !== "saving" && close()),
    undo,
    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };

  function frame(id: string, query: string, z: number): Frame {
    const f = doc.createElementNS(XHTML, "iframe") as Frame;
    f.id = id;
    // Out of the flow before it is appended (spike S8), and click-through until a phase needs it.
    f.style.cssText = `position: fixed; z-index: ${z}; border: 0; background: transparent; display: none; pointer-events: none`;
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
    // The bubble over the layer (which keeps the pointer until the toast): its buttons stay clickable.
    if (!layer?.isConnected) layer = frame("ressac-hide-layer", "hide", 3);
    if (!bubble?.isConnected) bubble = frame("ressac-hide-bubble", "hide-bubble", 4);
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
    Object.assign(layer.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px`, display: "", pointerEvents: ctx.phase === "toast" ? "none" : "auto" });
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
    pick = null;
    saved.clear();
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
  /** The pointer's last place over the layer: a scroll while armed outlines again what is now under it. */
  let lastPointer: [number, number] | null = null;
  async function hover(x: number, y: number) {
    nextHover = lastPointer = [x, y];
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
  /** A wheel over the armed layer scrolls the page itself (a plain scrollBy, no wheel event in it), then outlines again. */
  async function scroll(e: WheelEvent) {
    const b = selected();
    const z = b.fullZoom || 1;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? b.getBoundingClientRect().height : 1;
    const g = gen;
    await actorOf(b.browsingContext?.currentWindowGlobal)?.scrollBy((e.deltaX * unit) / z, (e.deltaY * unit) / z);
    if (g === gen && lastPointer) void hover(...lastPointer);
  }
  function listen(w: Window) {
    w.addEventListener("mousemove", (e) => ctx?.phase === "pick" && void hover(e.clientX, e.clientY));
    w.addEventListener("wheel", (e) => ctx?.phase === "pick" && void scroll(e), { passive: true });
    w.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      // Past the pick the layer holds the pointer until the toast: a click beside the bubble (or its error) ends the
      // gesture; never during a save, which always reaches its toast.
      if (ctx?.phase === "bubble" || ctx?.phase === "error") return void close();
      if (ctx?.phase !== "pick") return;
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
    // The answer's top document must still be the page shown: a navigation between the pick and here names another site.
    const top = String(b.currentURI?.spec ?? "");
    if (got.origin === null || got.origin !== originOf(top)) return close();
    const info = tabInfos(store.state).find((t) => t.id === tabId);
    const agentReached = info?.agentReached ?? true;
    // The top page's site (the kernel zones a tab by its top URL, so a frame's site would not mask it here), and only an
    // https one: the passport's sites match https pages only (originMatches), whatever a test seam allows.
    const origin = !agentReached && got.origin.startsWith("https://") && cleanOrigin(got.origin) !== null ? got.origin : null;
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
    const reached = () => tabInfos(store.state).find((t) => t.id === p.tab)?.agentReached ?? true;
    const written = await store.hidePassport.hide({
      profile: p.profile,
      field: choice.field,
      value: named ? { given: n!.given, family: n!.family } : { text: p.text },
      origin: p.origin,
      reason: format(locale(), "chrome-hide-reauth"),
    });
    // Asked once the write is done, whether or not the gesture is still shown: the site must not outlive the check.
    const reachedNow = reached();
    const r = await settleSite(written, reachedNow, () => store.hidePassport.unhide({ profile: p.profile, id: written.ok ? written.id : "", created: false, addedOrigin: true, updated: written.ok ? written.updated : "", origin: p.origin }));
    if (g !== gen || !ctx) return;
    if (!r.ok) {
      if (r.error === "cancelled") return close();
      return set({ ...ctx, phase: r.error === "invalid" ? "bubble" : "error", error: r.error });
    }
    // The ending asks the kernel about the page as it is now (its url, whether the agent reached it since): the value
    // alone, and the page's own text (each document's, top and frames), where a neighbour glued to it unmasks it. The
    // main token alone (no window) has the passport's sites now: the table a next conversation starts from.
    const url = String(p.browser.currentURI?.spec ?? store.state.tabs[p.tab]?.url ?? "");
    const value = p.text.trim();
    const ask = (text: string, windows = store.state.windows.map((w) => w.id)) => runsForAll((m, q) => store.agent.request(m, q), windows, { tab: p.tab, url, agentReached: reachedNow, text });
    const contexts: any[] = p.browser.browsingContext?.getAllBrowsingContextsInSubtree?.() ?? [];
    const [runs, docs] = await Promise.all([
      ask(value),
      Promise.all(contexts.map(async (bc) => {
        const { text } = joinPieces((await actorOf(bc.currentWindowGlobal)?.pieces()) ?? []);
        const [runs, next] = text.trim() ? await Promise.all([ask(text), ask(text, [])]) : [[], []];
        return { text, runs, next };
      })),
    ]);
    if (g !== gen || !ctx) return;
    const host = p.origin === null ? null : cleanOrigin(p.origin);
    const siteMatches = host !== null && originMatches(host, originOf(url));
    const end = ending({ agentReached: p.agentReached || reachedNow, runs, length: coverLength(choice.field, value), siteMatches, onPage: maskedOnPage(docs, value, choice.field), nextOnPage: maskedOnPage(docs.map((d) => ({ text: d.text, runs: d.next })), value, choice.field) });
    const undoable = r.created || r.addedOrigin;
    if (undoable) saved.open({ profile: p.profile, id: r.id, created: r.created, addedOrigin: r.addedOrigin, updated: r.updated, origin: p.origin });
    pick = null;
    // Saved while the user switched tabs (Touch ID was up): the toast still offers « Annuler », with nothing to draw
    // over a page that is no longer shown.
    const here = activeTab() === p.tab;
    // The e2e read the ending here: the chip's sentence lasts 2.5 s.
    layer!.dataset.ending = end;
    set({ ...ctx, phase: "toast", ending: end, created: r.created, undoable, readBefore: !!store.access.tabs[p.tab]?.read, chip: `⟨${FIELD_LABEL[choice.field]}-…⟩`, hover: undefined, ...(here ? {} : { target: undefined }), seq: ++seq });
    toastTimer = setTimeout(close, UNDO_MS);
  }

  async function undo() {
    const s = saved.take();
    if (!s) return;
    const g = gen;
    const ok = await store.hidePassport.unhide(s);
    if (g !== gen) return;
    if (ok || !ctx) return close();
    clearTimeout(toastTimer);
    set({ ...ctx, phase: "error", error: "write" });
  }

  // The content-area context menu: on a selection, or on an element with visible text (asked of the actor at the menu's
  // point as the menu opens: the item shows once the answer says there is text).
  const menu = doc.getElementById("contentAreaContextMenu");
  const item = doc.createXULElement("menuitem");
  item.id = "ressac-context-hide";
  let facts: { browser: any; got: Promise<Got | null> } | null = null;
  /** What the menu's point or selection holds, in the top window's px (a frame's answers shifted by its place). */
  async function menuTarget(browser: any, bc: any, selection: boolean, x: number, y: number): Promise<Got | null> {
    const top = actorOf(browser.browsingContext?.currentWindowGlobal);
    const own = actorOf(bc?.currentWindowGlobal);
    const offset = own ? await (own.constructor as typeof RessacHideParent).offsetOf(bc).catch(() => null) : null;
    if (!top || !own || !offset) return null;
    if (selection) {
      const s = await own.selection();
      return s && { text: s.text, rect: { ...s.rect, x: s.rect.x + offset.x, y: s.rect.y + offset.y }, origin: s.origin };
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const r = await top.at("pickAt", x + offset.x, y + offset.y).catch(() => null);
    return r && { text: r.text, rect: r.rect, origin: r.origin };
  }
  const onMenu = (e: Event) => {
    if (e.target !== menu) return;
    const cm = (win as any).gContextMenu;
    item.setAttribute("label", format(locale(), "chrome-hide"));
    (item as any).hidden = true;
    facts = null;
    if (!cm || !webPage(cm.browser) || cm.browser !== selected()) return;
    const c = cm.contentData?.context;
    const f = { browser: cm.browser, got: menuTarget(cm.browser, cm.frameBrowsingContext ?? cm.browser.browsingContext, !!cm.isTextSelected, Number(c?.clientX), Number(c?.clientY)) };
    facts = f;
    void f.got.then((got) => {
      if (got && facts === f) (item as any).hidden = false;
    });
  };
  const onCommand = async () => {
    const f = facts;
    if (!f || f.browser !== selected()) return;
    close();
    const g = gen;
    const got = await f.got;
    if (!got || g !== gen) return;
    await open(f.browser, { ...got, rect: scaled(got.rect, f.browser.fullZoom || 1) });
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
    // Touch ID may be up: the save goes on, and its toast still shows (confirm).
    if (moved && ctx && ctx.phase !== "saving") close();
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

/**
 * How long a page's masked slices are reused (only their rects re-measured each MARKS_EVERY_MS): a new passport entry, a
 * changed text or a new conversation shows within this; a passport push, a session change or a gone node at once.
 */
const RUNS_FRESH_MS = 1000;

/** host/masking.ts RUNS_CHARS: a longer page text gets no runs, so it is not walked again until a new document. */
const TEXT_CAP = 200_000;

/**
 * « Voir ce qu'il ne voit pas »: while the agent's aura is on the shown tab (`start(tab)`, `stop()`), a hatch over each
 * text of its top document the agent would receive masked (the kernel's mask.runs on the page's visible text, measured
 * by the RessacHide actor). Page-proof: the actor only answers; nothing listens in the page. The parent re-measures the
 * masked slices' rects every MARKS_EVERY_MS (a scroll or a resize shows within it, the page sends nothing), walks the
 * text and asks mask.runs again every RUNS_FRESH_MS, and starts over at each new document. Any window's conversation may run the tool behind the aura, so only what every conversation masks is
 * hatched (commonRuns).
 * shortcut: frames are not marked (their text is not in the top document's pieces); upgrade by walking the tab's
 * browsing contexts with RessacHideParent.offsetOf and clipping to each frame's box.
 */
export function mountMarks(win: Window, store: RessacStore, o: { agentReached(tab: string): boolean; aura(): AuraId }): { start(tab: string): void; stop(): void; dispose(): void } {
  const doc = win.document;
  let tab: string | null = null;
  let rects: HideRect[] | null = null;
  let f: (HTMLIFrameElement & { ressacMarks?: { api: MarksApi } }) | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  /** The shown document's masked slices, as of `at`: each tick only measures their rects (`pieces` walks the whole page). */
  let plan: { actor: RessacHideParent; key: string; at: number; slices: { piece: number; from: number; to: number }[][] } | null = null;
  /** Each forget: a plan made across one is used once, never kept (its runs may predate the change). */
  let epoch = 0;
  const forget = () => {
    plan = null;
    epoch++;
  };
  /** The shown document's text is over TEXT_CAP: not walked again until the next document. */
  let tooLong = false;
  const listeners = new Set<() => void>();
  const api: MarksApi = {
    marks: () => rects,
    locale: () => store.state.locale,
    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
  const browser = () => win.gBrowser?.selectedBrowser;

  function place() {
    const b = browser();
    if (!f || !b) return;
    const a = b.getBoundingClientRect();
    Object.assign(f.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  }
  function frame() {
    if (f?.isConnected) return;
    f = doc.createElementNS(XHTML, "iframe") as NonNullable<typeof f>;
    f.id = "ressac-hide-marks";
    // Over the tab box (z-index 2: at 2 the page painted over the marks, measured), under the gesture's frames (3, later
    // in the DOM or placed after it), never in the way of a click.
    f.style.cssText = "position: fixed; z-index: 3; border: 0; background: transparent; display: none; pointer-events: none";
    doc.getElementById("browser")!.insertBefore(f, doc.getElementById("ressac-hide-layer"));
    const mayLoad = cutFrameNetwork(f);
    f.ressacMarks = { api };
    f.addEventListener("load", tint, true);
    if (mayLoad) f.src = SRC + "hide-marks";
  }
  /** The aura's colours, at the frame's load and at each start (the space or its aura may have changed since). */
  function tint() {
    const w = f?.contentWindow;
    if (!w?.location.href.startsWith("chrome:")) return;
    for (const [k, v] of Object.entries(auraVariables(o.aura()))) w.document.documentElement.style.setProperty(k, v);
  }
  function draw(r: HideRect[] | null) {
    rects = r;
    clearTimeout(exitTimer);
    if (f) {
      if (r) {
        place();
        f.style.display = "";
      } else
        exitTimer = setTimeout(() => {
          if (!rects && f) f.style.display = "none";
        }, EXIT_MS);
    }
    for (const cb of listeners)
      try {
        cb();
      } catch (e) {
        console.error("[marks] listener failed:", e);
      }
  }

  /** The page's text walked again and asked of the kernel: the slices to measure until RUNS_FRESH_MS have passed. */
  async function replan(t: string, b: any, actor: RessacHideParent, key: string) {
    const e = epoch;
    const pieces = await actor.pieces();
    const { text, starts } = joinPieces(pieces);
    if (text.length > TEXT_CAP) tooLong = true;
    const runs = !text.trim() || tooLong ? [] : await runsForAll((m, q) => store.agent.request(m, q), store.state.windows.map((w) => w.id), { tab: t, url: String(b.currentURI?.spec ?? ""), agentReached: o.agentReached(t), text });
    // Same actor as `pieces`: its slices index into that answer's text nodes.
    const made = { actor, key, at: Date.now(), slices: runs.length ? runsToPieces(runs, starts, pieces.map((p) => p.text.length)) : [] };
    if (e === epoch) plan = made;
    return made;
  }
  async function measure(): Promise<HideRect[]> {
    const t = tab, b = browser();
    const actor = actorOf(b?.browsingContext?.currentWindowGlobal);
    if (!t || !actor || tooLong) return [];
    const key = JSON.stringify([store.state.windows.map((w) => w.id), t, String(b.currentURI?.spec ?? ""), o.agentReached(t)]);
    let p = plan?.actor === actor && plan.key === key && Date.now() - plan.at < RUNS_FRESH_MS ? plan : await replan(t, b, actor, key);
    if (!p.slices.length) return [];
    let got = await actor.rects(p.slices);
    // A slice's node is gone (or the answer is malformed): the page changed under the plan, so it is made again now.
    if (!got) {
      p = await replan(t, b, actor, key);
      got = p.slices.length ? await actor.rects(p.slices) : [];
    }
    const z = b.fullZoom || 1;
    const a = b.getBoundingClientRect();
    // Only what is in view: a long page's runs further down cost no drawing. A textarea's runs share its box: drawn once.
    const seen = new Set<string>();
    return (got ?? []).flat().map((r) => scaled(r, z)).filter((r) => r.x < a.width && r.y < a.height && r.x + r.width > 0 && r.y + r.height > 0 && !seen.has(JSON.stringify(r)) && !!seen.add(JSON.stringify(r)));
  }
  const marks = createMarks({ measure, draw, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (x) => clearTimeout(x as ReturnType<typeof setTimeout>) });

  // A new document in the shown tab: the old page's marks fade at once, the new page is measured from scratch.
  const progress = {
    onLocationChange(b: any, wp: any, _req: unknown, _loc: unknown, flags: number) {
      if (tab && b === browser() && wp?.isTopLevel && !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) {
        tooLong = false;
        forget();
        marks.stop();
        marks.start();
      }
    },
  };
  // Added at the first start: a site app's window may get its tabbrowser after this mount.
  let listening = false;
  const onResize = () => rects && place();
  win.addEventListener("resize", onResize);
  // The host says so after each passport push (a hide, an undo, a Réglages save) and each conversation opened or ended:
  // the plan is stale, measured again at once rather than within RUNS_FRESH_MS.
  const offMasking = store.agent.on("agent.masking", () => {
    forget();
    marks.nudge();
  });

  function stop() {
    tab = null;
    clearInterval(poll);
    marks.stop();
  }
  return {
    start(t) {
      if (tab === t) return;
      stop();
      tab = t;
      forget();
      tooLong = false;
      if (!listening && win.gBrowser) {
        win.gBrowser.addTabsProgressListener(progress);
        listening = true;
      }
      frame();
      tint();
      marks.start();
      poll = setInterval(marks.nudge, MARKS_EVERY_MS);
    },
    stop,
    dispose() {
      stop();
      clearTimeout(exitTimer);
      if (listening) win.gBrowser?.removeTabsProgressListener(progress);
      win.removeEventListener("resize", onResize);
      offMasking();
      f?.remove();
      listeners.clear();
    },
  };
}
