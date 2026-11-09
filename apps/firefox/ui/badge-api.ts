import type { BadgeApi } from "../shared/api";
import type { BadgeChrome } from "../chrome/store/apps";
import { local } from "./design-api";

/**
 * The API of an app window's badge (AppBadge.svelte), on what the chrome set on the frame
 * (store/apps.ts badge): its own app's access only. Every value from the chrome is copied into this realm, and a
 * rejection is made again here. Its design mode is its window's: the chrome knows the target, the badge sends none.
 */
export function createBadgeApi(raw: BadgeChrome): BadgeApi {
  // The chrome outlives this document: a listener into a dead document would throw on every call.
  const untilUnload = (unsubscribe: () => void) => {
    window.addEventListener("unload", unsubscribe, { once: true });
    return unsubscribe;
  };
  return {
    access: {
      state: () =>
        Promise.resolve()
          .then(() => structuredClone(raw.access.state()))
          .catch((e) => Promise.reject(local(e))),
      cut: (id, right) => raw.access.cut(id, right),
    },
    onAccess: (cb) => untilUnload(raw.onAccess((e) => cb(structuredClone(e)))),
    badgeSize: (opened) => void (typeof opened === "boolean" && raw.badgeSize(opened)),
    design: {
      state: () =>
        Promise.resolve()
          .then(() => raw.design.state())
          .then(
            (e) => structuredClone(e),
            (e) => Promise.reject(local(e)),
          ),
      toggle: () => raw.design.toggle(),
      basket: () => raw.design.basket(),
      review: () => raw.design.review(),
      // design.svelte.ts, in this bundle for App.svelte, subscribes as it loads; AppBadge reads the state as its menu opens.
      onChange: () => () => {},
    } as BadgeApi["design"],
  };
}
