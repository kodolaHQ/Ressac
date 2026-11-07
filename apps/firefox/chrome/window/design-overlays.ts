import type { ContexteCalque } from "../../../navigateur/src/commun/api";
import type { AgentHost } from "../agent/host";
import { overlayApi, type DesignOverlays, type DesignService, type DesignTarget } from "../store/design";
import { cleCible, DUREE_MESSAGE_MS } from "../store/design-copies";

// Electron's Calques (main/design/calque.ts) as chrome frames of sidebar.html?calque (spike S3): an html:iframe in
// #browser, over the remote page, transparent. Outside its rectangle the page keeps the mouse and the wheel. The page
// cannot see it (the view is remote), and it gets only its target's ApiCalque, set by the chrome on the frame.
// Bundled in the store (it outlives each window): every frame is made in the window `show` names.

const XHTML = "http://www.w3.org/1999/xhtml";
const SRC = "chrome://browser/content/webaios/sidebar.html?calque";
/** Spike S3's cart column of a main window: the page shrinks by it (window.css, --webaios-panier). */
export const COLUMN_WIDTH = 300;

type Mode = ContexteCalque["mode"];
type Place = { x: number; y: number; width: number; height: number };
type Frame = HTMLIFrameElement & { webaiosOverlay?: unknown };

interface Overlay {
  win: Window;
  /** The bubble, the message, an app window's cart. */
  calque?: Frame;
  /** A main window's cart column. */
  volet?: Frame;
  places: Partial<Record<Mode, Place>>;
  timer?: ReturnType<typeof setTimeout>;
  offKeys?: () => void;
}

export function createOverlays(o: { design: DesignService; host: Pick<AgentHost, "request" | "on"> }): DesignOverlays {
  const overlays = new Map<string, Overlay>();
  const closedListeners = new Map<string, Set<() => void>>();
  // The service's keys (cleCible), read back: the frame's target is the chrome's.
  const targetOf = (key: string): DesignTarget =>
    key.startsWith("fenetre:") ? { type: "fenetre", fenetreId: key.slice(8) } : key.startsWith("site:") ? { type: "site", id: key.slice(5) } : { type: "app", dossier: key.slice(4) };
  const main = (key: string) => key.startsWith("fenetre:");
  const inColumn = (key: string, mode: Mode) => mode === "panier" && main(key);
  /** Calques.contexte's order; a main window's cart is in its column. */
  const calqueModes = (key: string): Mode[] => (main(key) ? ["bulle", "message"] : ["bulle", "panier", "message"]);

  const columnClosed = (key: string) => {
    for (const cb of closedListeners.get(key) ?? [])
      try {
        cb();
      } catch (e) {
        console.error("[design] column listener failed:", e);
      }
  };

  function frame(key: string, ov: Overlay, kind: "calque" | "volet"): Frame {
    const existing = ov[kind];
    if (existing?.isConnected) return existing;
    const doc = ov.win.document;
    const f = doc.createElementNS(XHTML, "iframe") as Frame;
    f.id = kind === "volet" ? "webaios-design-volet" : "webaios-design-calque";
    // Out of the flow before it is appended (spike S8): in #browser's flex row a default iframe pushes the page aside.
    f.style.cssText = "position: fixed; z-index: 3; border: 0; background: transparent; display: none";
    doc.getElementById("browser")!.append(f);
    const t = targetOf(key);
    const api = kind === "volet" ? overlayApi({ ...o, modes: ["panier"], annuler: () => columnClosed(key) }, t) : overlayApi({ ...o, modes: calqueModes(key) }, t);
    f.webaiosOverlay = { api };
    // A bubble shown while the frame still loads: the keyboard once its document is there.
    if (kind === "calque") f.addEventListener("load", () => ov.places.bulle && f.focus());
    f.src = SRC;
    ov[kind] = f;
    return f;
  }

  /** The calque frame at the rectangle of what it shows; hidden when it shows nothing. */
  function layout(key: string, ov: Overlay) {
    const f = ov.calque;
    if (!f) return;
    const mode = calqueModes(key).find((m) => ov.places[m]);
    if (!mode) return void (f.style.display = "none");
    const p = ov.places[mode]!;
    Object.assign(f.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.width}px`, height: `${p.height}px`, display: "" });
  }

  const stopMessage = (ov: Overlay) => {
    clearTimeout(ov.timer);
    ov.offKeys?.();
    ov.offKeys = undefined;
  };

  const overlaysApi: DesignOverlays = {
    show(key, win, place, ctx) {
      let ov = overlays.get(key);
      if (ov && ov.win !== win) overlaysApi.forget(key);
      ov = overlays.get(key);
      if (!ov) overlays.set(key, (ov = { win, places: {} }));
      const t = targetOf(key);
      if (inColumn(key, ctx.mode)) {
        win.document.documentElement.style.setProperty("--webaios-panier", `${COLUMN_WIDTH}px`);
        frame(key, ov, "volet").style.display = "";
        return;
      }
      // A bubble opens: the message has no reason to stay (Calques.montrerBulle).
      if (ctx.mode === "bulle" && ov.places.message) o.design.closeOverlay(t, "message");
      ov.places[ctx.mode] = place;
      const f = frame(key, ov, "calque");
      if (ctx.mode === "message") {
        stopMessage(ov);
        const close = () => o.design.closeOverlay(t, "message");
        ov.timer = setTimeout(close, DUREE_MESSAGE_MS);
        // The next key, in the UI or in the page (the chrome window sees the remote page's keys first).
        win.addEventListener("keydown", close, true);
        ov.offKeys = () => win.removeEventListener("keydown", close, true);
      }
      layout(key, ov);
      if (ctx.mode === "bulle") f.focus();
    },

    hide(key, mode) {
      const ov = overlays.get(key);
      if (!ov) return;
      if (inColumn(key, mode)) {
        if (ov.volet) ov.volet.style.display = "none";
        if (!ov.win.closed) ov.win.document.documentElement.style.removeProperty("--webaios-panier");
        return;
      }
      delete ov.places[mode];
      if (mode === "message") stopMessage(ov);
      layout(key, ov);
    },

    forget(key) {
      const ov = overlays.get(key);
      if (!ov) return;
      overlays.delete(key);
      stopMessage(ov);
      if (ov.win.closed) return;
      ov.calque?.remove();
      ov.volet?.remove();
      ov.win.document.documentElement.style.removeProperty("--webaios-panier");
    },

    onColumnClosed(t, cb) {
      const key = cleCible(t);
      const set = closedListeners.get(key) ?? new Set();
      closedListeners.set(key, set.add(cb));
      return () => void set.delete(cb);
    },
  };
  return overlaysApi;
}
