import type { Action } from "../../../navigateur/src/commun/api";
import type { EtatNavigateur } from "../../../navigateur/src/commun/modele";
import { appliquer } from "../../../navigateur/src/main/etat/actions";

export type Listener = (state: EtatNavigateur, previous: EtatNavigateur) => void;

export interface Store {
  readonly state: EtatNavigateur;
  /** Clones `action` into this realm, applies it; listeners run only if the state changed. `genId` is passed to appliquer. */
  dispatch(action: Action, genId?: () => string): EtatNavigateur;
  subscribe(listener: Listener): () => void;
}

export function createStore(initial: EtatNavigateur): Store {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get state() {
      return state;
    },
    dispatch(action, genId) {
      const previous = state;
      // structuredClone: an action from another realm (Marionette, a window) must not alias our state.
      state = appliquer(previous, structuredClone(action), genId);
      if (state !== previous)
        for (const l of [...listeners]) {
          // One failing listener (a closing window…) must not skip the others nor fail the dispatch.
          try {
            l(state, previous);
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
