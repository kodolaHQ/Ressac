import type { HideApi, MarksApi, OverlayApi } from "../shared/api";
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

/** The API of a « Cacher pour l'agent » frame (HideApp.svelte), on what chrome/window/hide-layer.ts set on the frame. */
export function wrapHideApi(raw: HideApi, untilUnload: (unsubscribe: () => void) => () => void = untilWindowUnload): HideApi {
  return {
    context: () => structuredClone(raw.context()),
    confirm: (choice) => Promise.resolve(raw.confirm(structuredClone(choice))).then(() => {}),
    cancel: () => raw.cancel(),
    undo: () => Promise.resolve(raw.undo()).then(() => {}),
    onChange: (cb) => untilUnload(raw.onChange(() => cb())),
  };
}

/** The API of the marks frame (HideMarks.svelte). */
export function wrapMarksApi(raw: MarksApi, untilUnload: (unsubscribe: () => void) => () => void = untilWindowUnload): MarksApi {
  return { marks: () => structuredClone(raw.marks()), locale: () => String(raw.locale()), onChange: (cb) => untilUnload(raw.onChange(() => cb())) };
}
