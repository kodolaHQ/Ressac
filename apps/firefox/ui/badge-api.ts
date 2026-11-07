import type { ApiPastille } from "../../navigateur/src/commun/api";
import type { BadgeChrome } from "../chrome/store/apps";
import { local } from "./design-api";

/**
 * Electron's ApiPastille for an app window's badge (PastilleApp.svelte), on what the chrome set on the frame
 * (store/apps.ts badge): its own app's access only. Every value from the chrome is copied into this realm, and a
 * rejection is made again here. Design mode comes with plan 35b: its state is off, Mode design and Panier do nothing.
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
    // surChange: design.svelte.ts, in this bundle for App.svelte, subscribes as it loads (PastilleApp never calls it).
    design: {
      etat: async () => ({ actif: false, projet: null, indisponible: null, destination: null, sansDestination: null, panier: 0, nom: "" }),
      basculer: () => {},
      panier: () => {},
      relire: () => raw.relire(),
      surChange: () => () => {},
    } as ApiPastille["design"],
  };
}
