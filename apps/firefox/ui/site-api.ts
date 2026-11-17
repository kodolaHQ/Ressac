import type { ApiSite } from "../shared/api";
import type { SiteWindowController } from "../chrome/store/sites";
import { local } from "./design-api";

const off = () => () => {};

// The controller outlives this document: a listener into a dead document would throw on every call.
const untilUnload = (unsubscribe: () => void) => {
  window.addEventListener("unload", unsubscribe, { once: true });
  return unsubscribe;
};

/** What the home's frame (ui/SiteHomeFrame.svelte) uses of its API, in an app window or over an essential tab. */
export type HomeApi = Pick<ApiSite, "memory" | "open" | "image" | "onMemory" | "enter"> & { onState(callback: () => void): () => void };

/** The home's API on its chrome controller (the window's or the essential tab's); what comes out is copied. */
export function createHomeApi(c: Pick<SiteWindowController, "enter" | "memory" | "onMemory" | "openFromHome" | "image"> & { onState(cb: () => void): () => void }): HomeApi {
  return {
    onState: (cb) => untilUnload(c.onState(() => cb())),
    enter: () => c.enter(),
    // Rejects when the memory cannot be read: HomeFrame then sends nothing.
    memory: async () => {
      const m = await c.memory();
      if (!m) throw new Error("site app memory unavailable");
      return structuredClone(m);
    },
    onMemory: (cb) => untilUnload(c.onMemory((m) => cb(structuredClone(m)))),
    open: async (url) => c.openFromHome(url),
    image: async (url) => c.image(url),
  };
}

/**
 * The API of the site bar (SiteWindow.svelte), on the window's controller. What comes out of the chrome is
 * copied (structuredClone): the bar never holds the store's objects. The extension members do nothing: the add-on
 * buttons read the window's own (SiteAddonsStrip.svelte, ressacSiteWindow.addons), the extension menu is aliased away.
 * The design mode is the window's: the controller knows the app, the bar sends no target.
 */
export function createSiteApi(c: SiteWindowController): ApiSite {
  let lastDesign: Awaited<ReturnType<SiteWindowController["design"]["state"]>> | null = null;
  return {
    ...createHomeApi(c),
    state: async () => structuredClone(c.state()),
    onState: (cb) => untilUnload(c.onState((e) => cb(structuredClone(e)))),
    home: () => c.home(),
    previous: () => c.back(),
    next: () => c.forward(),
    reload: () => c.reload(),
    openBlocked: () => c.openBlocked(),
    lookupAddress: () => c.findAddress(),
    // Refuses a non-boolean choice and an unbounded hash.
    grant: async (yes, hash) => {
      if (typeof yes !== "boolean" || (hash !== undefined && (typeof hash !== "string" || hash.length > 128))) throw new Error("invalid accord request");
      await c.grant(yes, hash ?? "");
    },
    extensions: {
      list: async () => [],
      toggle: async () => ({ ok: false, error: "Pas encore disponible dans Ressac." }),
      bar: async () => ({ partition: "", tab: null, actions: [] }),
      onChange: off,
      manage: () => {},
      panel: () => {},
      onClose: off,
    },
    design: {
      // A host that does not answer: the last state again, never a rejection (spec §5.10);
      // SiteDesignButton would grey ✎ on a rejection.
      state: () =>
        Promise.resolve()
          .then(() => c.design.state())
          .then(
            (e) => structuredClone((lastDesign = e)),
            (e) => (lastDesign ? structuredClone(lastDesign) : Promise.reject(local(e))),
          ),
      toggle: () => c.design.toggle(),
      review: () => c.design.review(),
      openBasket: () => c.design.openCart(),
      onChange: (cb) => untilUnload(c.design.onChange(() => cb())),
    },
  };
}

/**
 * The whole `window.ressac` of a site bar or an app badge. The sidebar bundle also evaluates the main UI's modules,
 * which subscribe as they load (state.svelte.ts: surEtat, telechargements.liste()…): any member but `members`' own is
 * inert (callable, every property and result is itself, its `then` never calls back), and never mounted here.
 */
export function inertRessac(members: object): unknown {
  const inert: object = new Proxy(function () {}, { get: () => inert, apply: () => inert });
  return new Proxy(members, { get: (t, k) => (Object.hasOwn(t, k) ? t[k as keyof typeof t] : inert) });
}
