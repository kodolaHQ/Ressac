// « Cacher pour l'agent »: the read-only eye in the page. The child picks the element a person clicks and freezes its
// text, lists the page's visible text pieces and measures text slices; all drawing is the parent's (Ressac's layer).
// Page-proof: nothing is added to, styled in or selected in the page, and every listener sits on the docshell's
// chromeEventHandler, in front of any page listener (as design-actor.ts's guard). Packaged: a change here needs build:ui.

import type { TextPiece } from "../../core/hide/text-map";

// An actor module has no timers of its own.
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

/** Every mouse event the page could see while picking: swallowed when trusted. */
const MOUSE = ["pointerdown", "pointerup", "pointermove", "pointerover", "pointerout", "pointerenter", "pointerleave", "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave", "click", "auxclick", "dblclick", "contextmenu"];
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "SELECT", "TEXTAREA"]);
/** Far above any passport value: the parent refuses what is too long, this only bounds a message. */
const TEXT_MAX = 10_000;
const FADED = 0.05;

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Callback = (name: string, data: unknown) => void;

const collapse = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
/** What a person reads in `el`: innerText leaves out its hidden descendants (a display:none decoy), textContent not. */
const textOf = (el: Element) => collapse((el as HTMLElement).innerText ?? el.textContent);

/**
 * Where `win`'s viewport sits in the top window, CSS px (zoom is the tab's, the same in every frame).
 * shortcut: stops at a frame of another process (its embedder is not here), so such a frame's rects are its own
 * viewport's; upgrade when the parent layer draws over cross-process frames (ask the embedder's actor for the offset).
 */
function offsetOf(win: Window): Point {
  const o = { x: 0, y: 0 };
  for (let bc = (win as any).browsingContext; bc?.parent; bc = bc.parent) {
    const el = bc.embedderElement as Element | null;
    if (!el) break;
    const r = el.getBoundingClientRect(), cs = el.ownerDocument.defaultView!.getComputedStyle(el);
    o.x += r.x + el.clientLeft + parseFloat(cs.paddingLeft);
    o.y += r.y + el.clientTop + parseFloat(cs.paddingTop);
  }
  return o;
}

const plain = (r: DOMRect, o: Point): Rect => ({ x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height });

/** Seen by a person at the point: takes the pointer, not hidden, not faded with its ancestors. */
function shown(el: Element): boolean {
  const view = el.ownerDocument.defaultView!;
  const cs = view.getComputedStyle(el);
  if (cs.pointerEvents === "none" || cs.visibility === "hidden") return false;
  let o = 1;
  for (let e: Element | null = el; e; e = e.parentElement) if ((o *= Number(view.getComputedStyle(e).opacity)) < FADED) return false;
  return true;
}

/**
 * The element a click at (x, y) means: through invisible and pointer-less layers, the first one with text, then its
 * smallest descendant under the point that still has text. A frame's element yields null (its own document answers),
 * and so do body and html.
 */
function pickAt(doc: Document, x: number, y: number): Element | null {
  const under = (p: Element): Element | null => {
    for (const c of p.children) {
      const r = c.getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom && textOf(c) && shown(c)) return c;
    }
    return null;
  };
  for (const el of doc.elementsFromPoint(x, y)) {
    // The page itself is not « the text clicked »: an empty spot picks nothing.
    if (el.tagName === "IFRAME" || el.tagName === "FRAME" || el === doc.body || el === doc.documentElement) return null;
    if (!textOf(el) || !shown(el)) continue;
    let best = el;
    for (let c = under(best); c; c = under(best)) best = c;
    return best;
  }
  return null;
}

/** The visible text nodes of `doc`, in order, each with whether a block boundary precedes it. */
function piecesOf(doc: Document): { nodes: Text[]; pieces: TextPiece[] } {
  const nodes: Text[] = [];
  const pieces: TextPiece[] = [];
  let block = false;
  const walk = (node: Node, opacity: number, visible: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node as Text).data;
      if (visible && text) {
        pieces.push({ text, block });
        nodes.push(node as Text);
        block = false;
      }
      return;
    }
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const c of node.childNodes) walk(c, opacity, visible);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (SKIP.has(el.tagName)) return;
    const cs = el.ownerDocument.defaultView!.getComputedStyle(el);
    if (!cs || cs.display === "none") return;
    const o = opacity * Number(cs.opacity);
    if (o < FADED) return;
    const isBlock = el.tagName === "BR" || (!cs.display.startsWith("inline") && cs.display !== "contents");
    if (isBlock) block = true;
    const v = cs.visibility === "visible";
    // A UA widget's root (a text input's value, video controls) is the browser's, not the page's (page-actor.ts too).
    const own = (el as any).openOrClosedShadowRoot as (ShadowRoot & { isUAWidget(): boolean }) | null;
    if (own && !own.isUAWidget()) walk(own, o, v);
    else if (el.tagName === "SLOT") {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      for (const c of assigned.length ? assigned : el.childNodes) walk(c, o, v);
    } else if (el.tagName !== "IFRAME" && el.tagName !== "FRAME") for (const c of el.childNodes) walk(c, o, v);
    if (isBlock) block = true;
  };
  const root = doc.body ?? doc.documentElement;
  if (root) walk(root, 1, true);
  return { nodes, pieces };
}

const owners = new WeakMap<object, Callback>();

/** The parent layer listens to the `hover`/`picked`/`stopped` messages of a tab's `<browser>`; returns how to stop. */
export function onHideMessage(browser: Element, cb: Callback): () => void {
  owners.set(browser, cb);
  return () => {
    if (owners.get(browser) === cb) owners.delete(browser);
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const rectOf = (v: any): Rect | null => (v && typeof v === "object" ? { x: num(v.x), y: num(v.y), width: num(v.width), height: num(v.height) } : null);

export class RessacHideParent extends JSWindowActorParent {
  receiveMessage(msg: { name: string; data: any }): void {
    const browser = this.browsingContext?.top?.embedderElement;
    const cb = browser && owners.get(browser);
    if (!cb) return;
    // The sender may be a compromised web process: known names, typed fields, the origin from its own WindowGlobal.
    const d = msg.data ?? {};
    switch (msg.name) {
      case "RessacHide:hover":
        return cb("hover", { rect: rectOf(d.rect) });
      case "RessacHide:picked":
        if (typeof d.text !== "string" || !d.text) return;
        return cb("picked", { text: d.text.slice(0, TEXT_MAX), rect: rectOf(d.rect), origin: this.manager.documentPrincipal.origin });
      case "RessacHide:stopped":
        return cb("stopped", {});
    }
  }
}

export class RessacHideChild extends JSWindowActorChild {
  private unarm: (() => void) | null = null;
  /** The text nodes of the last `pieces`: `rects` slices index into them. */
  private nodes: Text[] = [];

  /** The actor of `doc`'s own window (a frame of this process sends for its own site). */
  private actorOf(doc: Document): RessacHideChild | null {
    if (doc === this.document) return this;
    try {
      return (doc.defaultView as any)?.windowGlobalChild?.getActor("RessacHide") ?? null;
    } catch {
      return null; // not an http(s) document: no actor
    }
  }

  /**
   * Capture listeners on this window's chrome event handler, which also handles the frames of this process. Trusted
   * mouse events stop there; a move reports the element under it, a primary click freezes its text and disarms (the
   * rest of a double click is swallowed 500 ms more), Escape disarms.
   */
  private arm(): boolean {
    this.unarm?.();
    const h = this.docShell.chromeEventHandler;
    const doc = this.document;
    let last: Element | null | undefined;
    let picking = true;
    let timer: unknown;
    const target = (e: Event): Document | null => {
      const t = e.target as Node | null;
      return t ? (t.nodeType === Node.DOCUMENT_NODE ? (t as Document) : t.ownerDocument) : null;
    };
    const mouse = (e: MouseEvent) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const d = picking && target(e);
      if (!d) return;
      if (e.type === "mousemove") {
        const el = pickAt(d, e.clientX, e.clientY);
        if (el === last) return;
        last = el;
        this.actorOf(d)?.sendAsyncMessage("RessacHide:hover", { rect: el ? plain(el.getBoundingClientRect(), offsetOf(d.defaultView!)) : null });
      } else if (e.type === "click" && e.button === 0) {
        const el = pickAt(d, e.clientX, e.clientY);
        if (!el) return;
        // Frozen now: what the page does to the element after the click never reaches the passport.
        const text = textOf(el);
        picking = false;
        this.actorOf(d)?.sendAsyncMessage("RessacHide:picked", { text, rect: plain(el.getBoundingClientRect(), offsetOf(d.defaultView!)), origin: (d as any).nodePrincipal.origin });
        timer = setTimeout(unarm, 500);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (!e.isTrusted || e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      unarm();
      this.sendAsyncMessage("RessacHide:stopped", {});
    };
    // A page kept in the bfcache is never destroyed (no didDestroy): leaving it disarms.
    const hide = (e: Event) => {
      if (e.isTrusted && e.target === doc) unarm();
    };
    for (const t of MOUSE) h.addEventListener(t, mouse, true);
    h.addEventListener("keydown", key, true);
    h.addEventListener("pagehide", hide, true);
    const unarm = () => {
      clearTimeout(timer);
      for (const t of MOUSE) h.removeEventListener(t, mouse, true);
      h.removeEventListener("keydown", key, true);
      h.removeEventListener("pagehide", hide, true);
      if (this.unarm === unarm) this.unarm = null;
    };
    this.unarm = unarm;
    return true;
  }

  private selection(): { text: string; rect: Rect; origin: string } | null {
    const sel = this.contentWindow?.getSelection();
    const text = collapse(sel?.toString() ?? "");
    if (!sel || !text || !sel.rangeCount) return null;
    return { text, rect: plain(sel.getRangeAt(0).getBoundingClientRect(), offsetOf(this.contentWindow!)), origin: (this.document as any).nodePrincipal.origin };
  }

  /** Each run's slices measured with a detached Range (never the selection), top-window CSS px. */
  private rects(slices: unknown): Rect[][] {
    if (!Array.isArray(slices)) return [];
    const o = offsetOf(this.contentWindow!);
    const range = this.document.createRange();
    return slices.map((run) =>
      (Array.isArray(run) ? run : []).flatMap((s: any) => {
        const node = this.nodes[s?.piece];
        if (!node?.isConnected || !Number.isInteger(s.from) || !Number.isInteger(s.to)) return [];
        const len = node.data.length;
        range.setStart(node, Math.min(Math.max(0, s.from), len));
        range.setEnd(node, Math.min(Math.max(0, s.to), len));
        return [...range.getClientRects()].filter((r) => r.width > 0).map((r) => plain(r, o));
      }),
    );
  }

  // The chrome event handler is the tab's (or the frame's), not this document's: the listeners go with the window.
  didDestroy(): void {
    this.unarm?.();
    this.nodes = [];
  }

  receiveMessage(m: { name: string; data?: any }): unknown {
    switch (m.name) {
      // One guard per process: a frame of this process is already behind its process root's.
      case "arm":
        return this.manager.isProcessRoot ? this.arm() : false;
      case "stop":
        this.unarm?.();
        return true;
      case "selection":
        return this.selection();
      case "pieces": {
        const { nodes, pieces } = piecesOf(this.document);
        this.nodes = nodes;
        return { pieces };
      }
      case "rects":
        return { rects: this.rects(m.data?.slices) };
    }
    return null;
  }
}
