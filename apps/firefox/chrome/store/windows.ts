import type { EtatNavigateur, IdFenetre } from "../../shared/modele";
import type { WindowController } from "../window/controller";
import type { Store } from "./store";

/** Pure: which state window a new Firefox window takes (decision 1), or null to create one. */
export function pickWindow(
  state: EtatNavigateur,
  o: { bound: ReadonlySet<IdFenetre>; kept: IdFenetre | null; opening: readonly IdFenetre[] },
): IdFenetre | null {
  const free = (id: IdFenetre | null) => !!id && !o.bound.has(id) && state.fenetres.some((f) => f.id === id);
  return o.opening.find(free) ?? (free(o.kept) ? o.kept : null) ?? state.fenetres.find((f) => free(f.id))?.id ?? null;
}

export interface WindowRegistry {
  /** Binds a new full browser window; creates a state window (ouvrirFenetre, espaceId of active()) when pickWindow gives null. Bound before any dispatch. */
  claim(win: Window): { fenetreId: IdFenetre; first: boolean };
  /** The window is gone: calls onRelease first; among others, fermerFenetre; the last one, or any while
   *  Services.startup.shuttingDown, stays in the state (kept: the next claim takes it back). */
  release(fenetreId: IdFenetre): void;
  /** Decision 3. undefined while no WebAiOs window is open. */
  active(): IdFenetre | undefined;
  /** The open window and its controller, if any. */
  get(fenetreId: IdFenetre): { window: Window; controller: WindowController } | undefined;
}

/** One full Firefox window per state window, and the kept ones. */
export function createWindowRegistry(o: {
  store: Store;
  open(): Window | undefined;
  onRelease(fenetreId: IdFenetre): void;
  /** A bound window came to the front: active() may have changed. */
  onActivate?(fenetreId: IdFenetre): void;
}): WindowRegistry {
  const { store } = o;
  const bound = new Map<IdFenetre, Window>();
  let kept: IdFenetre | null = null;
  let opening: IdFenetre[] = [];
  let claimed = false;
  let lastActive: IdFenetre | undefined;

  // A state window whose Firefox window is gone: among other open windows it leaves the state, the last one is kept
  // (macOS: the Dock or ⌘N bring it back). While quitting every window stays, for the restore.
  const forget = (id: IdFenetre) => {
    if (!Services.startup.shuttingDown && bound.size > 0) store.dispatch({ type: "fermerFenetre", id });
    else kept = id;
  };

  // A state window with no Firefox window (restored, or added by an action) gets one, unless kept closed (macOS).
  const openMissing = (state: EtatNavigateur) => {
    if (!claimed || Services.startup.shuttingDown) return;
    opening = opening.filter((id) => !bound.has(id) && state.fenetres.some((f) => f.id === id));
    for (const f of state.fenetres)
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
      let fenetreId = pickWindow(store.state, { bound: new Set(bound.keys()), kept, opening });
      if (fenetreId) {
        opening = opening.filter((id) => id !== fenetreId);
        if (kept === fenetreId) kept = null;
        bound.set(fenetreId, win);
      } else {
        const id: IdFenetre = crypto.randomUUID();
        const from = registry.active();
        const espaceId = store.state.fenetres.find((f) => f.id === from)?.espaceActif;
        bound.set(id, win);
        store.dispatch({ type: "ouvrirFenetre", id, ...(espaceId ? { espaceId } : {}) });
        fenetreId = id;
      }
      const id = fenetreId;
      win.addEventListener("activate", () => {
        lastActive = id;
        o.onActivate?.(id);
      });
      openMissing(store.state);
      return { fenetreId: id, first };
    },
    release(fenetreId) {
      if (!bound.delete(fenetreId)) return;
      if (lastActive === fenetreId) lastActive = undefined;
      o.onRelease(fenetreId);
      forget(fenetreId);
    },
    active() {
      const focused = Services.focus.activeWindow;
      for (const [id, w] of bound) if (w === focused) return id;
      if (lastActive && bound.has(lastActive)) return lastActive;
      return store.state.fenetres.find((f) => bound.has(f.id))?.id;
    },
    get(fenetreId) {
      const window = bound.get(fenetreId);
      const controller = window?.webaiosWindow;
      return window && controller ? { window, controller } : undefined;
    },
  };
  return registry;
}
