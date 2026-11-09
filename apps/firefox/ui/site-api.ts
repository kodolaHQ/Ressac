import type { ApiSite } from "../shared/api";
import type { SiteWindowController } from "../chrome/store/sites";
import { local } from "./design-api";

const off = () => () => {};

/**
 * The API of the site bar (FenetreSite.svelte), on the window's controller. What comes out of the chrome is
 * copied (structuredClone): the bar never holds the store's objects. The extension members do nothing: the add-on
 * buttons read the window's own (SiteAddonsStrip.svelte, webaiosSiteWindow.addons), the extension menu is aliased away.
 * The design mode is the window's: the controller knows the app, the bar sends no target.
 */
export function createSiteApi(c: SiteWindowController): ApiSite {
  // The controller outlives this document: a listener into a dead document would throw on every call.
  const untilUnload = (unsubscribe: () => void) => {
    window.addEventListener("unload", unsubscribe, { once: true });
    return unsubscribe;
  };
  let lastDesign: Awaited<ReturnType<SiteWindowController["design"]["etat"]>> | null = null;
  return {
    etat: async () => structuredClone(c.state()),
    surEtat: (cb) => untilUnload(c.onState((e) => cb(structuredClone(e)))),
    entrer: () => c.enter(),
    accueil: () => c.home(),
    precedent: () => c.back(),
    suivant: () => c.forward(),
    recharger: () => c.reload(),
    ouvrirBloque: () => c.openBlocked(),
    chercherAdresse: () => c.findAddress(),
    // Refuses a non-boolean choice and an unbounded fingerprint.
    accorder: async (oui, empreinte) => {
      if (typeof oui !== "boolean" || (empreinte !== undefined && (typeof empreinte !== "string" || empreinte.length > 128))) throw new Error("invalid accord request");
      await c.accord(oui, empreinte ?? "");
    },
    // Rejects when the memory cannot be read: CadreAccueil then sends nothing.
    memoire: async () => {
      const m = await c.memory();
      if (!m) throw new Error("site app memory unavailable");
      return structuredClone(m);
    },
    surMemoire: (cb) => untilUnload(c.onMemory((m) => cb(structuredClone(m)))),
    ouvrir: async (adresse) => c.openFromHome(adresse),
    image: async (url) => c.image(url),
    extensions: {
      liste: async () => [],
      basculer: async () => ({ ok: false, erreur: "Pas encore disponible dans WebAiOs-Firefox." }),
      barre: async () => ({ partition: "", onglet: null, actions: [] }),
      surChange: off,
      gerer: () => {},
      panneau: () => {},
      surFermer: off,
    },
    design: {
      // A host that does not answer: the last state again, never a rejection (spec §5.10);
      // BoutonDesignSite would grey ✎ on a rejection.
      etat: () =>
        Promise.resolve()
          .then(() => c.design.etat())
          .then(
            (e) => structuredClone((lastDesign = e)),
            (e) => (lastDesign ? structuredClone(lastDesign) : Promise.reject(local(e))),
          ),
      basculer: () => c.design.toggle(),
      relire: () => c.design.relire(),
      ouvrirPanier: () => c.design.openCart(),
      surChange: (cb) => untilUnload(c.design.onChange(() => cb())),
    },
  };
}

/**
 * The whole `window.webaios` of a site bar or an app badge. The sidebar bundle also evaluates the main UI's modules,
 * which subscribe as they load (etat.svelte.ts: surEtat, telechargements.liste()…): any member but `members`' own is
 * inert (callable, every property and result is itself, its `then` never calls back), and never mounted here.
 */
export function inertWebaios(members: object): unknown {
  const inert: object = new Proxy(function () {}, { get: () => inert, apply: () => inert });
  return new Proxy(members, { get: (t, k) => (Object.hasOwn(t, k) ? t[k as keyof typeof t] : inert) });
}
