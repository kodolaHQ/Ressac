// « Cacher pour l'agent »: the read-only eye in the page. The child answers the parent's questions only (what text is
// at a point, the page's visible text pieces, the rects of text slices); it listens to nothing, so the page never sees
// a pointer while picking: Ressac's layer over the <browser> captures it and asks here with coordinates. All drawing
// is the parent's. Nothing is added to, styled in or selected in the page. Packaged: a change here needs build:ui.

import { colourAlpha as alpha, joinPieces, type TextPiece } from "../../core/hide/text-map";

// The agent read's filter (page-actor.ts, 158072da): the same skipped tags and opacity threshold, UA widget roots
// skipped. Copied, not imported: a module shared by two actor entries would become a chunk the jar does not ship.
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "SELECT", "TEXTAREA", "svg"]);
const FADED = 0.05;
/** Far above any passport value: the parent refuses what is too long, this only bounds a message. */
const TEXT_MAX = 10_000;
const RECT_MAX = 100_000;

type Rect = { x: number; y: number; width: number; height: number };
type Frame = { frame: { browsingContextId: number; x: number; y: number } };
type Hit = { text: string; rect: Rect } | Frame | null;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const styleOf = (el: Element) => el.ownerDocument.defaultView!.getComputedStyle(el);
/** The element's own shadow root, unless a UA widget's (a text input's value, video controls): the agent read skips those. */
const ownRoot = (el: Element): ShadowRoot | null => {
  const own = (el as any).openOrClosedShadowRoot as (ShadowRoot & { isUAWidget(): boolean }) | null;
  return own && !own.isUAWidget() ? own : null;
};
const parentOf = (n: Node): Element | null => (n as Element).assignedSlot ?? n.parentElement ?? ((n.parentNode as ShadowRoot | null)?.host ?? null);
/** Seen as a box: visibility visible and opacity, with the ancestors', at least FADED (piecesOf's rule for an element). */
const seen = (el: Element): boolean => {
  if (styleOf(el).visibility !== "visible") return false;
  let o = 1;
  for (let e: Element | null = el; e; e = parentOf(e)) if ((o *= Number(styleOf(e).opacity)) < FADED) return false;
  return true;
};
/** A box a person sees with something drawn on it (a colour or an image): it hides what lies under it. */
const painted = (el: Element): boolean => {
  const cs = styleOf(el);
  return (alpha(cs.backgroundColor) > 0 || cs.backgroundImage !== "none") && seen(el);
};

/** Finite, non-negative size, within RECT_MAX: what a compromised process sends is never a huge or NaN drawing. */
function bounded(v: any): Rect | null {
  if (!v || typeof v !== "object") return null;
  const n = [v.x, v.y, v.width, v.height];
  if (!n.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const c = (x: number, lo: number) => Math.min(RECT_MAX, Math.max(lo, x));
  return { x: c(v.x, -RECT_MAX), y: c(v.y, -RECT_MAX), width: c(v.width, 0), height: c(v.height, 0) };
}
const plain = (r: DOMRect): Rect => bounded({ x: r.x, y: r.y, width: r.width, height: r.height })!;

/**
 * The visible text nodes under `root`, in order, each with whether a block boundary precedes it. One rule for the
 * page's pieces, a pick and its frozen text: no display:none, visibility other than visible, opacity (with the
 * ancestors') under FADED, fully transparent colour (gradient text aside), skipped tag or UA widget root.
 */
function piecesOf(root: Element): { nodes: Text[]; pieces: TextPiece[] } {
  const nodes: Text[] = [];
  const pieces: TextPiece[] = [];
  // The context above `root`: its ancestors' opacity and tags (a display:none ancestor leaves root unrendered).
  let above = 1;
  for (let e = parentOf(root); e; e = parentOf(e)) {
    if (SKIP.has(e.tagName)) return { nodes, pieces };
    above *= Number(styleOf(e).opacity);
  }
  if (!(root as any).checkVisibility?.()) return { nodes, pieces };
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
    const cs = styleOf(el);
    if (cs.display === "none") return;
    const o = opacity * Number(cs.opacity);
    if (o < FADED) return;
    const isBlock = el.tagName === "BR" || (!cs.display.startsWith("inline") && cs.display !== "contents");
    if (isBlock) block = true;
    const v = cs.visibility === "visible" && (alpha(cs.color) > 0 || cs.backgroundClip === "text");
    const shadow = ownRoot(el);
    if (shadow) walk(shadow, o, v);
    else if (el.tagName === "SLOT") {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      for (const c of assigned.length ? assigned : el.childNodes) walk(c, o, v);
    } else if (el.tagName !== "IFRAME" && el.tagName !== "FRAME") for (const c of el.childNodes) walk(c, o, v);
    if (isBlock) block = true;
  };
  walk(root, above, true);
  return { nodes, pieces };
}

/**
 * A frame element's content box in its document's viewport, CSS px.
 * shortcut: a transformed iframe (rotate, scale) gets wrong coordinates, its box is not its frame's mapping; upgrade
 * with convertPointFromNode/getBoxQuads if a site needs it.
 */
function contentBox(el: Element): Rect {
  const r = el.getBoundingClientRect(), cs = styleOf(el);
  const x = r.x + el.clientLeft + parseFloat(cs.paddingLeft), y = r.y + el.clientTop + parseFloat(cs.paddingTop);
  return { x, y, width: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), height: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) };
}

/**
 * What a click at (x, y) of `doc`'s viewport means: the first element under the point, through pointer-less layers,
 * whose own text node is rendered under the point and visible by piecesOf's rule; it is the smallest element holding
 * that text. Its frozen text is its subtree's visible text. A frame first under the point answers for itself (its
 * coordinates translated into its viewport) if seen; an empty spot of a wrapper, text nobody sees there, or a painted
 * box over the text, picks nothing.
 * shortcut: text inside a shadow root is reached only through its host's own text nodes; upgrade if a site needs it.
 */
function hitAt(doc: Document, x: number, y: number): Hit {
  const range = doc.createRange();
  const under = (t: Text) => {
    range.selectNodeContents(t);
    return [...range.getClientRects()].some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom);
  };
  for (const el of doc.elementsFromPoint(x, y)) {
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      if (!seen(el)) continue;
      const bc = (el as any).browsingContext;
      if (!bc) return null;
      const box = contentBox(el);
      return { frame: { browsingContextId: bc.id, x: x - box.x, y: y - box.y } };
    }
    if (styleOf(el).pointerEvents === "none") continue;
    const texts = [...el.childNodes].filter((n): n is Text => n.nodeType === Node.TEXT_NODE && !!(n as Text).data.trim() && under(n as Text));
    const { nodes, pieces } = texts.length ? piecesOf(el) : { nodes: [], pieces: [] };
    // No visible text of its own under the point: a painted box hides what is under it, anything else is seen through.
    if (!texts.some((t) => nodes.includes(t))) {
      if (painted(el)) return null;
      continue;
    }
    // Frozen here: what the page does to the element after the pick never reaches the passport.
    return { text: collapse(joinPieces(pieces).text), rect: plain(el.getBoundingClientRect()) };
  }
  return null;
}

const actorOf = (wg: any): RessacHideParent | null => {
  try {
    return wg?.getActor("RessacHide") ?? null;
  } catch {
    return null; // not an http(s) document: no actor
  }
};

export class RessacHideParent extends JSWindowActorParent {
  /** The text a person points at in `browser`, in its top window's CSS px (frames followed): `{ text, rect, origin }` or null. */
  static pickAt(browser: any, x: number, y: number): Promise<{ text: string; rect: Rect; origin: string | null } | null> {
    return actorOf(browser.browsingContext?.currentWindowGlobal)?.at("pickAt", x, y) ?? Promise.resolve(null);
  }

  /** The outline under the point: `{ rect }` or null. */
  static async hoverAt(browser: any, x: number, y: number): Promise<{ rect: Rect } | null> {
    const r = await actorOf(browser.browsingContext?.currentWindowGlobal)?.at("hoverAt", x, y);
    return r ? { rect: r.rect } : null;
  }

  /** Where frame `bc`'s viewport sits in its top window, CSS px, each embedder's document reporting its frame's box. */
  static async offsetOf(bc: any): Promise<{ x: number; y: number } | null> {
    const o = { x: 0, y: 0 };
    for (let c = bc; c?.parent; c = c.parent) {
      const box = bounded(await actorOf(c.parent.currentWindowGlobal)?.sendQuery("frameBox", { browsingContextId: c.id }).catch(() => null));
      if (!box) return null;
      o.x += box.x;
      o.y += box.y;
    }
    return o;
  }

  /** This document's origin, from its WindowGlobal (never the child's word), without a container's suffix; null for a null or opaque principal. */
  get origin(): string | null {
    const p = this.manager.documentPrincipal;
    return p?.isContentPrincipal ? p.originNoSuffix : null;
  }

  /** This document's answer at (x, y) of its viewport; a frame's is asked of that frame's actor and shifted back. */
  async at(kind: "pickAt" | "hoverAt", x: number, y: number): Promise<{ text: string; rect: Rect; origin: string | null } | null> {
    const r: any = await this.sendQuery(kind, { x, y }).catch(() => null);
    if (r?.frame) {
      const { browsingContextId: id, x: fx, y: fy } = r.frame;
      if (typeof fx !== "number" || typeof fy !== "number" || !Number.isFinite(fx) || !Number.isFinite(fy)) return null;
      // Only a frame of this document: a child cannot send the parent to another tab's frame.
      const child = this.browsingContext.children.find((c: any) => c.id === id);
      const sub = await actorOf(child?.currentWindowGlobal)?.at(kind, fx, fy);
      const rect = sub && bounded({ ...sub.rect, x: sub.rect.x + x - fx, y: sub.rect.y + y - fy });
      return sub && rect ? { ...sub, rect } : null;
    }
    const rect = bounded(r?.rect);
    if (!rect) return null;
    if (kind === "hoverAt") return { text: "", rect, origin: null };
    if (typeof r.text !== "string" || !r.text) return null;
    return { text: r.text.slice(0, TEXT_MAX), rect, origin: this.origin };
  }

  /** The current selection of this document: `{ text, rect, origin }` (rect in its own viewport) or null. */
  async selection(): Promise<{ text: string; rect: Rect; origin: string | null } | null> {
    const r: any = await this.sendQuery("selection").catch(() => null);
    const rect = bounded(r?.rect);
    return rect && typeof r.text === "string" && r.text ? { text: r.text.slice(0, TEXT_MAX), rect, origin: this.origin } : null;
  }

  /** This document's visible text pieces; `rects` slices index into the last answer. */
  async pieces(): Promise<TextPiece[]> {
    const r: any = await this.sendQuery("pieces").catch(() => null);
    return Array.isArray(r?.pieces) ? r.pieces.filter((p: any) => typeof p?.text === "string" && typeof p.block === "boolean") : [];
  }

  /** Each run's rects, in this document's viewport (add offsetOf for a frame). */
  async rects(slices: { piece: number; from: number; to: number }[][]): Promise<Rect[][]> {
    const r: any = await this.sendQuery("rects", { slices }).catch(() => null);
    return Array.isArray(r?.rects) ? r.rects.map((run: unknown) => (Array.isArray(run) ? run.map(bounded).filter((x): x is Rect => !!x) : [])) : [];
  }
}

export class RessacHideChild extends JSWindowActorChild {
  /** The text nodes of the last `pieces`: `rects` slices index into them. */
  private nodes: Text[] = [];

  private selection(): { text: string; rect: Rect } | null {
    const sel = this.contentWindow?.getSelection();
    const text = collapse(sel?.toString() ?? "");
    return sel && text && sel.rangeCount ? { text, rect: plain(sel.getRangeAt(0).getBoundingClientRect()) } : null;
  }

  /** Each run's slices measured with a detached Range (never the selection), in this viewport's CSS px. */
  private rects(slices: unknown): Rect[][] {
    if (!Array.isArray(slices)) return [];
    const range = this.document.createRange();
    return slices.map((run) =>
      (Array.isArray(run) ? run : []).flatMap((s: any) => {
        const node = this.nodes[s?.piece];
        if (!node?.isConnected || !Number.isInteger(s.from) || !Number.isInteger(s.to)) return [];
        const len = node.data.length;
        range.setStart(node, Math.min(Math.max(0, s.from), len));
        range.setEnd(node, Math.min(Math.max(0, s.to), len));
        return [...range.getClientRects()].filter((r) => r.width > 0).map(plain);
      }),
    );
  }

  didDestroy(): void {
    this.nodes = [];
  }

  receiveMessage(m: { name: string; data?: any }): unknown {
    const x = m.data?.x, y = m.data?.y;
    const at = typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y);
    switch (m.name) {
      case "pickAt":
        return at ? hitAt(this.document, x, y) : null;
      case "hoverAt": {
        const hit = at ? hitAt(this.document, x, y) : null;
        return hit && "rect" in hit ? { rect: hit.rect } : hit;
      }
      case "frameBox": {
        const el = [...this.document.querySelectorAll("iframe, frame")].find((f) => (f as any).browsingContext?.id === m.data?.browsingContextId);
        return el ? contentBox(el) : null;
      }
      case "selection":
        return this.selection();
      case "pieces": {
        const root = this.document.body ?? this.document.documentElement;
        const { nodes, pieces } = root ? piecesOf(root) : { nodes: [], pieces: [] };
        this.nodes = nodes;
        return { pieces };
      }
      case "rects":
        return { rects: this.rects(m.data?.slices) };
    }
    return null;
  }
}
