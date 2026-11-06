import type { ApiSite } from "../../navigateur/src/commun/api";
import type { SiteWindowController } from "../chrome/store/sites";

const off = () => () => {};

/**
 * Electron's ApiSite for the site bar (FenetreSite.svelte), on the window's controller. What comes out of the chrome is
 * copied (structuredClone): the bar never holds the store's objects. No extensions nor design mode in
 * plan 31: those members do nothing (nobody calls the extension and design ones, their components are aliased away).
 */
export function createSiteApi(c: SiteWindowController): ApiSite {
  // The controller outlives this document: a listener into a dead document would throw on every call.
  const untilUnload = (unsubscribe: () => void) => {
    window.addEventListener("unload", unsubscribe, { once: true });
    return unsubscribe;
  };
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
    // Electron's IPC schema refuses a non-boolean choice and an unbounded fingerprint.
    accorder: async (oui, empreinte) => {
      if (typeof oui !== "boolean" || (empreinte !== undefined && (typeof empreinte !== "string" || empreinte.length > 128))) throw new Error("invalid accord request");
      await c.accord(oui, empreinte ?? "");
    },
    // Electron's invoke rejects when the memory cannot be read: CadreAccueil then sends nothing.
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
      etat: async () => ({ actif: false, projet: null, indisponible: null, destination: null, sansDestination: null, panier: 0, nom: "" }),
      basculer: () => {},
      relire: () => {},
      ouvrirPanier: () => {},
      surChange: off,
    },
  };
}

/**
 * The site bar's whole `window.webaios`. The sidebar bundle also evaluates the main UI's modules, which subscribe as
 * they load (etat.svelte.ts: surEtat, telechargements.liste()…): any member but `site` is inert (callable, every
 * property and result is itself, its `then` never calls back), and never mounted here.
 */
export function siteWebaios(site: ApiSite): unknown {
  const inert: object = new Proxy(function () {}, { get: () => inert, apply: () => inert });
  return new Proxy({ site }, { get: (t, k) => (k === "site" ? t.site : inert) });
}
