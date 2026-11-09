import type { BrowserState, WindowId } from "../../shared/model";
import type { WindowController } from "../window/controller";
import type { Store } from "./store";

/** Pure: which state window a new Firefox window takes (decision 1), or null to create one. */
export function pickWindow(
  state: BrowserState,
  o: { bound: ReadonlySet<WindowId>; kept: WindowId | null; opening: readonly WindowId[] },
): WindowId | null {
  const free = (id: WindowId | null) => !!id && !o.bound.has(id) && state.windows.some((f) => f.id === id);
  return o.opening.find(free) ?? (free(o.kept) ? o.kept : null) ?? state.windows.find((f) => free(f.id))?.id ?? null;
}

export interface WindowRegistry {
  /** Binds a new full browser window; creates a state window (ouvrirFenetre, espaceId of active()) when pickWindow gives null. Bound before any dispatch. */
  claim(win: Window): { windowId: WindowId; first: boolean };
  /** The window is gone: calls onRelease first; among others, fermerFenetre; the last one, or any while
   *  Services.startup.shuttingDown, stays in the state (kept: the next claim takes it back). */
  release(windowId: WindowId): void;
  /** Decision 3. undefined while no WebAiOs window is open. */
  active(): WindowId | undefined;
  /** The open window and its controller, if any. */
  get(windowId: WindowId): { window: Window; controller: WindowController } | undefined;
}

/** One full Firefox window per state window, and the kept ones. */
export function createWindowRegistry(o: {
  store: Store;
  open(): Window | undefined;
  onRelease(windowId: WindowId): void;
  /** A bound window came to the front: active() may have changed. */
  onActivate?(windowId: WindowId): void;
}): WindowRegistry {
  const { store } = o;
  const bound = new Map<WindowId, Window>();
  let kept: WindowId | null = null;
  let opening: WindowId[] = [];
  let claimed = false;
  let lastActive: WindowId | undefined;

  // A state window whose Firefox window is gone: among other open windows it leaves the state, the last one is kept
  // (macOS: the Dock or ⌘N bring it back). While quitting every window stays, for the restore.
  const forget = (id: WindowId) => {
    if (!Services.startup.shuttingDown && bound.size > 0) store.dispatch({ type: "closeWindow", id });
    else kept = id;
  };

  // A state window with no Firefox window (restored, or added by an action) gets one, unless kept closed (macOS).
  const openMissing = (state: BrowserState) => {
    if (!claimed || Services.startup.shuttingDown) return;
    opening = opening.filter((id) => !bound.has(id) && state.windows.some((f) => f.id === id));
    for (const f of state.windows)
      if (!bound.has(f.id) && f.id !== kept && !opening.includes(f.id)) {
        const id = f.id;
        opening.push(id);
        // Closed before it could claim (before Firefox's delayed startup): its state window is gone as well.
        o.open()?.addEventListener(
          "unload",
          () => {
            if (!opening.includes(id)) return;
            opening = opening.filter((x) => x !== id);
            forget(id);
          },
          { once: true },
        );
      }
  };
  store.subscribe(openMissing);

  const registry: WindowRegistry = {
    claim(win) {
      const first = !claimed;
      claimed = true;
      let windowId = pickWindow(store.state, { bound: new Set(bound.keys()), kept, opening });
      if (windowId) {
        opening = opening.filter((id) => id !== windowId);
        if (kept === windowId) kept = null;
        bound.set(windowId, win);
      } else {
        const id: WindowId = crypto.randomUUID();
        const from = registry.active();
        const spaceId = store.state.windows.find((f) => f.id === from)?.activeSpace;
        bound.set(id, win);
        store.dispatch({ type: "openWindow", id, ...(spaceId ? { spaceId: spaceId } : {}) });
        windowId = id;
      }
      const id = windowId;
      win.addEventListener("activate", () => {
        lastActive = id;
        o.onActivate?.(id);
      });
      openMissing(store.state);
      return { windowId: id, first };
    },
    release(windowId) {
      if (!bound.delete(windowId)) return;
      if (lastActive === windowId) lastActive = undefined;
      o.onRelease(windowId);
      forget(windowId);
    },
    active() {
      const focused = Services.focus.activeWindow;
      for (const [id, w] of bound) if (w === focused) return id;
      if (lastActive && bound.has(lastActive)) return lastActive;
      return store.state.windows.find((f) => bound.has(f.id))?.id;
    },
    get(windowId) {
      const window = bound.get(windowId);
      const controller = window?.webaiosWindow;
      return window && controller ? { window, controller } : undefined;
    },
  };
  return registry;
}
