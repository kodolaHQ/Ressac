import type { OverlayApi } from "../shared/api";
import { local } from "./design-api";

// The chrome outlives this document: a listener into a dead document would throw on every call.
const untilWindowUnload = (unsubscribe: () => void) => {
  window.addEventListener("unload", unsubscribe, { once: true });
  return unsubscribe;
};

/**
 * The API of a design overlay frame (DesignApp.svelte), on what the chrome set on the frame
 * (chrome/window/design-overlays.ts): every answer copied into this realm, every rejection made again here.
 */
export function wrapOverlayApi(raw: OverlayApi, untilUnload: (unsubscribe: () => void) => () => void = untilWindowUnload): OverlayApi {
  const copy = <T>(call: () => Promise<T>): Promise<T> =>
    Promise.resolve()
      .then(call)
      .then(
        (v) => structuredClone(v),
        (e) => Promise.reject(local(e)),
      );
  return {
    context: () => copy(() => raw.context()),
    add: (text) => copy(() => raw.add(text)),
    cancel: () => raw.cancel(),
    basket: (p) => copy(() => raw.basket(p)),
    remove: (p, id) => copy(() => raw.remove(p, id)),
    send: (p) => copy(() => raw.send(p)),
    batches: (p) => copy(() => raw.batches(p)),
    handled: (p, batch) => copy(() => raw.handled(p, batch)),
    onChange: (cb) => untilUnload(raw.onChange(() => cb())),
  };
}
