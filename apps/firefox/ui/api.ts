import type { ApiWebaios } from "../../navigateur/src/commun/api";
import type { WindowController } from "../chrome/window/controller";

declare global {
  interface Window {
    webaios: ApiWebaios;
    /** ApiWebaios members the UI reached that this api does not implement (read by the e2e). */
    webaiosMissingApi?: Set<string>;
  }
}

const off = () => () => {};
const none = async () => [];
const unavailable = async () => ({ ok: false as const, erreur: "Pas encore disponible dans WebAiOs-Firefox." });

/**
 * The Electron preload's `window.webaios`, on the Firefox window controller. What step 2 leaves out (agent, access,
 * history, downloads, permissions, extensions, actions) answers empty; any other member is recorded in
 * `window.webaiosMissingApi` and is undefined.
 */
export function createApi(win: WindowController): ApiWebaios {
  const missing = (window.webaiosMissingApi ??= new Set());
  const api: Partial<ApiWebaios> = {
    fenetreId: win.fenetreId,
    agir: (action) => void win.store.dispatch(action),
    surEtat(callback) {
      // The state lives in the store's realm: the UI always gets its own copy, made in this realm.
      const send = () => callback(structuredClone(win.store.state));
      if (win.store.state) send();
      const unsubscribe = win.store.subscribe(send);
      // The store outlives this document: a listener into a dead document would throw on every dispatch.
      window.addEventListener("unload", unsubscribe, { once: true });
      return unsubscribe;
    },
    surRaccourci(callback) {
      const unsubscribe = win.onShortcut(callback);
      window.addEventListener("unload", unsubscribe, { once: true });
      return unsubscribe;
    },
    surPanneauOnglets(callback) {
      const unsubscribe = win.onTabPanel((p) => callback(p && structuredClone(p)));
      window.addEventListener("unload", unsubscribe, { once: true });
      return unsubscribe;
    },
    parcoursOnglets: (m) => win.tabSwitch(m),
    naviguer: (id, input) => win.navigate(id, input),
    // shortcut: zoom, find in page and devtools are out of step 2 and do nothing.
    commande: (id, c) => void (typeof c === "string" && c !== "finRecherche" && c !== "outils" && win.command(id, c)),
    rendreFocusPage: () => win.focusPage(),
    apercuPage: async () => null,
    historique: { rechercher: none, recents: none, effacer: async () => {}, oublierTexte: async () => {} },
    telechargements: { liste: none, ouvrir() {}, montrer() {}, annuler() {} },
    surTelechargements: off,
    permissions: { enAttente: none, repondre() {} },
    surPermissions: off,
    acces: { etat: async () => ({ onglets: {}, agent: "L'agent" }), couper() {} },
    surAcces: off,
    // The command bar's sources besides tabs: none in step 2.
    applications: { liste: async () => ({ atelier: "ok", applications: [] }), surChange: off, agir() {} },
    sites: { liste: none, surChange: off, agir() {} },
    // Only what the reused space modal, empty page and command bar call.
    extensions: { pourEspace: none, surChange: off, basculer: unavailable } as unknown as ApiWebaios["extensions"],
    actions: { liste: none, surChange: off, ouvrir: unavailable } as unknown as ApiWebaios["actions"],
  };
  return new Proxy(api, {
    get(target, key) {
      if (typeof key === "string" && !(key in target)) missing.add(key);
      return Reflect.get(target, key);
    },
  }) as ApiWebaios;
}
