import type { ApiPastille } from "../shared/api";
import type { BadgeChrome } from "../chrome/store/apps";
import { local } from "./design-api";

/**
 * Electron's ApiPastille for an app window's badge (PastilleApp.svelte), on what the chrome set on the frame
 * (store/apps.ts badge): its own app's access only. Every value from the chrome is copied into this realm, and a
 * rejection is made again here. Its design mode is its window's: the chrome knows the target, the badge sends none.
 */
export function createBadgeApi(raw: BadgeChrome): ApiPastille {
  // The chrome outlives this document: a listener into a dead document would throw on every call.
  const untilUnload = (unsubscribe: () => void) => {
    window.addEventListener("unload", unsubscribe, { once: true });
    return unsubscribe;
  };
  return {
    acces: {
      etat: () =>
        Promise.resolve()
          .then(() => structuredClone(raw.acces.etat()))
          .catch((e) => Promise.reject(local(e))),
      couper: (id, droit) => raw.acces.couper(id, droit),
    },
    surAcces: (cb) => untilUnload(raw.surAcces((e) => cb(structuredClone(e)))),
    pastilleTaille: (ouverte) => void (typeof ouverte === "boolean" && raw.pastilleTaille(ouverte)),
    design: {
      etat: () =>
        Promise.resolve()
          .then(() => raw.design.etat())
          .then(
            (e) => structuredClone(e),
            (e) => Promise.reject(local(e)),
          ),
      basculer: () => raw.design.basculer(),
      panier: () => raw.design.panier(),
      relire: () => raw.design.relire(),
      // design.svelte.ts, in this bundle for App.svelte, subscribes as it loads; PastilleApp reads the state as its menu opens.
      surChange: () => () => {},
    } as ApiPastille["design"],
  };
}
