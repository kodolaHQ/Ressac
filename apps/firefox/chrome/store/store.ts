import type { Action } from "../../shared/api";
import type { BrowserState } from "../../shared/model";
import { apply } from "../../core/state/actions";

export type Listener = (state: BrowserState, previous: BrowserState, action: Action) => void;

export interface Store {
  readonly state: BrowserState;
  /** Clones `action` into this realm, applies it; listeners run only if the state changed. `genId` is passed to appliquer. */
  dispatch(action: Action, genId?: () => string): BrowserState;
  subscribe(listener: Listener): () => void;
}

export function createStore(initial: BrowserState): Store {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get state() {
      return state;
    },
    dispatch(action, genId) {
      const previous = state;
      // structuredClone: an action from another realm (Marionette, a window) must not alias our state.
      const own = structuredClone(action);
      state = apply(previous, own, genId);
      if (state !== previous)
        for (const l of [...listeners]) {
          // One failing listener (a closing window…) must not skip the others nor fail the dispatch.
          try {
            l(state, previous, own);
          } catch (e) {
            console.error("[store] listener failed:", e);
          }
        }
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
