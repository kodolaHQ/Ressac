// The UI's network, pieces 3 and 5 (spec 2026-11-08-webaios-firefox-reseau-interfaces-design.md, spike S1): every UI
// frame's docShell is cut from DNS prefetch and preloads before its src, and its window's link presses warm no
// connection. Bundled in window.js and in the store (design-overlays.ts): each copy guards a window once.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
type UiNetwork = typeof import("../store").uiNetwork;
const uiNetwork = (): UiNetwork => ChromeUtils.importESModule(STORE).uiNetwork;

const guarded = new WeakSet<Window>();
const warned = new WeakSet<Window>();

/**
 * A mousedown on a link of a UI document is consumed: Element::PostHandleEventForLinks then skips its
 * SpeculativeConnect (measured, S1). Its click still comes. A pressed link's speculative connect is refused in every UI
 * document, system ones included (measured: a sidebar link resolved its name and opened a TCP connection). Tabs and
 * the apps' views are content, never the UI's.
 */
function onPress(e: Event): void {
  const t = ((e as any).composedTarget ?? e.target) as Node | null;
  // A text node's element (3: Node.TEXT_NODE; the store's global has no Node).
  const el = (t?.nodeType === 3 ? t.parentElement : t) as Element | null;
  if (!el?.closest?.(":any-link")) return;
  if (uiNetwork().isUiDocument(el.ownerDocument)) e.preventDefault();
}

/**
 * Call after the frame is in the document and before its src. Sets allowDNSPrefetch = false and
 * appType = APP_TYPE_MAIL on its docShell, guards its window's link presses (once per window), and says whether
 * the frame may get its src: false when the observer is missing or the docShell cannot be reached.
 */
export function cutFrameNetwork(frame: HTMLIFrameElement): boolean {
  const win = frame.ownerDocument.defaultView!;
  const ds = (frame as any).frameLoader?.docShell ?? (frame.contentWindow as any)?.docShell;
  if (!ds) {
    console.error(`[ui-network] no docShell for the frame ${frame.id}: it stays empty`);
    return false;
  }
  ds.allowDNSPrefetch = false;
  ds.appType = Ci.nsIDocShell.APP_TYPE_MAIL;
  if (!guarded.has(win)) {
    guarded.add(win);
    win.windowRoot.addEventListener("mousedown", onPress, true);
  }
  if (uiNetwork().state()?.observer) return true;
  if (!warned.has(win)) {
    warned.add(win);
    console.error("[ui-network] the UI's network guard is missing: UI frames stay empty");
  }
  return false;
}
