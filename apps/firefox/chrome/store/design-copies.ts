// The design mode's pure pieces: core/design/viewfinder.ts's viewfinderScript, adapted for the actor's guard, and the checks
// on what comes back from the page.
import type { DesignContext } from "../../../../packages/kernel/src/design/remarks";
import type { DesignTarget } from "../../core/design/foreground";
import { viewfinderScript, type ViewfinderCapture } from "../../core/design/viewfinder";
import { truncateHtml } from "../shims/kernel";

export { rectCapture } from "../../core/design/viewfinder";
export type { ViewfinderCapture };

export const SOURCE_TIMEOUT_MS = 1500;

// The design overlays' sizes and placement.
type Rectangle = { x: number; y: number; width: number; height: number };
/** A note's bubble: 320×170, below the element. */
export const BUBBLE_SIZE = { width: 320, height: 170 };
/** The bubble in a site app: 20 px more for the warning line. */
export const SITE_BUBBLE_SIZE = { width: 320, height: 190 };
const BUBBLE_GAP = 6;
// The unavailability message: 360×56, 12 px from the top and right of the tab's view.
export const MESSAGE_WIDTH = 360;
export const MESSAGE_HEIGHT = 56;
export const MESSAGE_MARGIN = 12;
// An app window's cart, 340 px on the right, 12 px from the edges.
export const MARGIN = 12;
export const BASKET_WIDTH = 340;
/** The unavailability message closes by itself after this. */
export const MESSAGE_DURATION_MS = 4000;

/** Key of a target, also the argument of its overlay. */
export const targetKey = (c: DesignTarget): string =>
  c.type === "window" ? `window:${c.windowId}` : c.type === "app" ? `app:${c.folder}` : `site:${c.id}`;

/**
 * Placement of the bubble in the window: below the element (CSS rect × zoom, shifted by the bounds of the page's view), bounded
 * to the window, and never above `hautMin` (the bottom of a site app's bar).
 */
export function bubbleSlot(
  rect: ViewfinderCapture["rect"],
  zoom: number,
  bounds: Rectangle,
  win: [number, number],
  o: { minHeight?: number; height?: number } = {},
): Rectangle {
  const height = o.height ?? BUBBLE_SIZE.height;
  const clamp = (v: number, max: number) => Math.round(Math.max(0, Math.min(v, max)));
  return {
    x: clamp(bounds.x + rect.x * zoom, win[0] - BUBBLE_SIZE.width),
    y: Math.max(o.minHeight ?? 0, clamp(bounds.y + (rect.y + rect.height) * zoom + BUBBLE_GAP, win[1] - height)),
    width: BUBBLE_SIZE.width,
    height,
  };
}

/**
 * viewfinderScript without its own click listener: the actor's guard (design-actor.ts), in front of every page
 * listener, hands it the clicked element through `globalThis.__viewfinderPick`, which `fin` deletes with `__viewfinderStop`.
 * Hover, Escape, swallowing and stop stay viewfinderScript's code. Throws when viewfinderScript's text changes.
 */
export function firefoxViewfinderScript(): string {
  let s = viewfinderScript();
  const edits: [string, string][] = [
    ['      window.removeEventListener("click", surClic, true);\n', ""],
    ["if (globalThis.__viewfinderStop === arret) delete globalThis.__viewfinderStop;", "if (globalThis.__viewfinderStop === arret) { delete globalThis.__viewfinderStop; delete globalThis.__viewfinderPick; }"],
    ["const surClic = (e) => {\n      if (!e.isTrusted) return;\n      bloque(e);\n      const el = e.target;", "const choisir = (el) => {"],
    ['window.addEventListener("click", surClic, true);', "globalThis.__viewfinderPick = choisir;"],
  ];
  for (const [a, b] of edits) {
    if (!s.includes(a)) throw new Error(`viewfinderScript changed: ${a}`);
    s = s.replace(a, b);
  }
  return s;
}

// Stops the viewfinder and its double-click swallowing in the page.
export const STOP_SCRIPT = `typeof globalThis.__viewfinderStop === "function" && globalThis.__viewfinderStop(); typeof globalThis.__viewfinderSwallow === "function" && globalThis.__viewfinderSwallow()`;

// Shape guards for what comes back from the page.
const finished = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const chain = (c: unknown, max = 1_000_000): c is string => typeof c === "string" && c.length <= max;
const positiveInteger = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/** The isolated world is safe, but the shape is checked anyway: null if it is not the expected one. */
function tidyCapture(v: unknown): ViewfinderCapture | null {
  const c = v as Partial<ViewfinderCapture> | null;
  if (!c || typeof c !== "object" || !c.rect || !c.view || !c.neighborhood || !c.styles) return null;
  if (![c.rect.x, c.rect.y, c.rect.width, c.rect.height, c.view.width, c.view.height].every(finished)) return null;
  if (![c.selector, c.label, c.html, c.url, c.neighborhood.parent].every((x) => chain(x))) return null;
  if (!Array.isArray(c.neighborhood.siblings) || !c.neighborhood.siblings.every((f) => chain(f))) return null;
  if (!Object.values(c.styles).every((x) => chain(x))) return null;
  return c as ViewfinderCapture;
}

/** What comes from the page's world is never trusted: short file, positive integer numbers, the rest is dropped. */
function healthySource(r: unknown): DesignContext["source"] {
  const o = r as { file?: unknown; line?: unknown; column?: unknown } | null;
  if (!o || typeof o !== "object" || !chain(o.file, 1024) || o.file === "") return null;
  return { file: o.file, ...(positiveInteger(o.line) ? { line: o.line } : {}), ...(positiveInteger(o.column) ? { column: o.column } : {}) };
}

/** The viewfinder script's answer: the shape checked, the html cut. */
export function cleanCapture(v: unknown): ViewfinderCapture | null {
  const c = tidyCapture(v);
  return c ? { ...c, html: truncateHtml(c.html) } : null;
}

export const cleanSource = (r: unknown): DesignContext["source"] => healthySource(r);

/** lireSource's expression (run in the actor's sandbox with Xrays waived): no effect, no global. */
export function sourceExpression(selector: string): string {
  return `(() => {
    try {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const ds = el.getAttribute("data-source");
      if (ds) { const m = /^(.*?):(\\d+)(?::(\\d+))?$/.exec(ds); return m ? { file: m[1], line: Number(m[2]), ...(m[3] ? { column: Number(m[3]) } : {}) } : { file: ds }; }
      const ch = el.getAttribute("data-inspector-relative-path"), li = el.getAttribute("data-inspector-line");
      if (ch && li) return { file: ch, line: Number(li) };
      const loc = el.__svelte_meta && el.__svelte_meta.loc;
      if (loc && loc.file) return { file: loc.file, line: loc.line, column: loc.column };
      const vue = el.__vueParentComponent && el.__vueParentComponent.type && el.__vueParentComponent.type.__file;
      if (vue) return { file: vue };
      const cle = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      if (cle) {
        let f = el[cle];
        for (let i = 0; f && i < 50; i++, f = f.return)
          if (f._debugSource && f._debugSource.fileName) return { file: f._debugSource.fileName, line: f._debugSource.lineNumber };
      }
      return null;
    } catch { return null; }
  })()`;
}
