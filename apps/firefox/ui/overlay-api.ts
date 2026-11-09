import type { ApiCalque } from "../shared/api";
import { local } from "./design-api";

// The chrome outlives this document: a listener into a dead document would throw on every call.
const untilWindowUnload = (unsubscribe: () => void) => {
  window.addEventListener("unload", unsubscribe, { once: true });
  return unsubscribe;
};

/**
 * Electron's ApiCalque for a design overlay frame (DesignApp.svelte), on what the chrome set on the frame
 * (chrome/window/design-overlays.ts): every answer copied into this realm, every rejection made again here.
 */
export function wrapOverlayApi(raw: ApiCalque, untilUnload: (unsubscribe: () => void) => () => void = untilWindowUnload): ApiCalque {
  const copy = <T>(call: () => Promise<T>): Promise<T> =>
    Promise.resolve()
      .then(call)
      .then(
        (v) => structuredClone(v),
        (e) => Promise.reject(local(e)),
      );
  return {
    contexte: () => copy(() => raw.contexte()),
    ajouter: (texte) => copy(() => raw.ajouter(texte)),
    annuler: () => raw.annuler(),
    panier: (p) => copy(() => raw.panier(p)),
    retirer: (p, id) => copy(() => raw.retirer(p, id)),
    envoyer: (p) => copy(() => raw.envoyer(p)),
    lots: (p) => copy(() => raw.lots(p)),
    traite: (p, lot) => copy(() => raw.traite(p, lot)),
    surChange: (cb) => untilUnload(raw.surChange(() => cb())),
  };
}
