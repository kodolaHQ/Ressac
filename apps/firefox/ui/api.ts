import type { ApiWebaios, EtatPanneauAgent, ResultatExtension, WidgetAffiche } from "../../navigateur/src/commun/api";
import type { LigneExtension, LigneExtensionEspace } from "../../navigateur/src/commun/extensions";
import type { ThemeAccueil } from "../../../packages/noyau/src/accueil/theme.ts";
import type { PlacementLibre } from "../../../packages/noyau/src/accueil/schemas.ts";
import type { Execution, ResumeExecution } from "../../../packages/noyau/src/workflows/executions.ts";
import { HOST_EXITED } from "../chrome/agent/host";
import type { WindowController } from "../chrome/window/controller";
import { oublierWidget, preparerWidget } from "../chrome/window/widget-frame";
import { profilsLisibles, profilsPourAccord, urlOuvrable } from "./accueil-profils";

/** What the Firefox page reads: Electron's widgets, plus the theme the frozen API did not carry. */
export interface AccueilLu {
  widgets: WidgetAffiche[];
  theme: ThemeAccueil | null;
}

/** The Electron preload's API, with the home page's read widened to carry the theme and free placements (Task 7). */
export interface ApiFirefox extends Omit<ApiWebaios, "accueil"> {
  accueil: Omit<ApiWebaios["accueil"], "lire" | "placer"> & {
    lire(): Promise<AccueilLu>;
    placer(placements: PlacementLibre[]): void;
  };
}

declare global {
  interface Window {
    webaios: ApiFirefox;
    /** ApiWebaios members the UI reached that this api does not implement (read by the e2e). */
    webaiosMissingApi?: Set<string>;
  }
}

const off = () => () => {};
const none = async () => [];
const unavailable = async () => ({ ok: false as const, erreur: "Pas encore disponible dans WebAiOs-Firefox." });

/**
 * Serves each widget's display: writes its sanitized copy under `<dataDir>/webaios-widgets/<id>/` and points `src` at
 * its resource:// URL. The widgets served last time and gone now lose their substitution and their copies.
 */
async function servirAffichages(widgets: WidgetAffiche[], dataDir: string, prepares: Set<string>): Promise<void> {
  const maintenant = new Set<string>();
  await Promise.all(
    widgets.map(async (w) => {
      if (!("src" in w) || w.src === null) return;
      const url = await preparerWidget(dataDir, w.id);
      w.src = url;
      if (url) maintenant.add(w.id);
    }),
  );
  for (const id of prepares) if (!maintenant.has(id)) await oublierWidget(dataDir, id);
  prepares.clear();
  for (const id of maintenant) prepares.add(id);
}

/**
 * The Electron preload's `window.webaios`, on the Firefox window controller. What is not migrated yet (applications, sites,
 * extensions, actions) answers empty; any other member is recorded in `window.webaiosMissingApi` and is undefined.
 */
export function createApi(win: WindowController): ApiFirefox {
  const missing = (window.webaiosMissingApi ??= new Set());
  // The store outlives this document: a listener into a dead document would throw on every call.
  const untilUnload = (unsubscribe: () => void) => {
    window.addEventListener("unload", unsubscribe, { once: true });
    return unsubscribe;
  };
  const host = win.store.agent;
  const fenetre = win.fenetreId;
  /** When this window last opened a widget link: a display cannot make links leave in a burst. */
  let dernierLien = 0;
  /** States this document makes itself: the host did not start, or stopped. */
  const localStates = new Set<(e: EtatPanneauAgent) => void>();
  /** The widgets whose display this document prepared: the others' substitutions and copies are cleared. */
  const prepares = new Set<string>();
  const failed = (message: string) => localStates.forEach((cb) => cb({ etat: "erreur", message }));
  /** An extension action in the noyau host; its answer copied into this realm, a failure given back as text. */
  const extension = (method: string, params: Record<string, unknown>) =>
    host.request<ResultatExtension>(method, params).then((r) => structuredClone(r), (e) => ({ ok: false as const, erreur: e instanceof Error ? e.message : String(e) }));
  const api: Partial<ApiFirefox> = {
    fenetreId: win.fenetreId,
    // A tab the user closes may ask first (Electron's ipc.ts sends fermerOnglet to Vues.fermer).
    agir: (action) => void (action.type === "fermerOnglet" ? win.closeTab(action.id) : win.store.dispatch(action)),
    surEtat(callback) {
      // The state lives in the store's realm: the UI always gets its own copy, made in this realm.
      const send = () => callback(structuredClone(win.store.state));
      if (win.store.state) send();
      return untilUnload(win.store.subscribe(send));
    },
    surRaccourci: (callback) => untilUnload(win.onShortcut(callback)),
    surPanneau: (callback) => untilUnload(win.onPanel(callback)),
    surPanneauOnglets: (callback) => untilUnload(win.onTabPanel((p) => callback(p && structuredClone(p)))),
    // The window's terminal session, in the noyau host. Its output and states are routed by window.
    agent: {
      demarrer(taille) {
        // Starts the host again if it stopped (Réessayer after a crash).
        host
          .ensure()
          .then(() => host.request("agent.demarrer", { fenetre, taille }))
          .catch((e) => failed(e instanceof Error ? e.message : String(e)));
      },
      ecrire: (d) => host.notify("agent.ecrire", { fenetre, d }),
      redimensionner: (taille) => host.notify("agent.redimensionner", { fenetre, taille }),
      surDonnees: (callback) => untilUnload(host.on("agent.donnees", (p) => p.fenetre === fenetre && callback(String(p.d)))),
      surEtat(callback) {
        localStates.add(callback);
        const offState = host.on("agent.etat", (p) => p.fenetre === fenetre && callback(structuredClone(p.e)));
        const offExit = host.on(HOST_EXITED, (p) => callback({ etat: "erreur", message: p.message }));
        return untilUnload(() => {
          localStates.delete(callback);
          offState();
          offExit();
        });
      },
      profils: () => host.request<{ id: string; nom: string }[]>("agent.profils").then((p) => structuredClone(p), () => []),
    },
    parcoursOnglets: (m) => win.tabSwitch(m),
    naviguer: (id, input) => win.navigate(id, input),
    // shortcut: zoom, find in page and devtools are out of step 2 and do nothing.
    commande: (id, c) => void (typeof c === "string" && c !== "finRecherche" && c !== "outils" && win.command(id, c)),
    rendreFocusPage: () => win.focusPage(),
    apercuPage: async () => null,
    // The visits live in the noyau host: the UI gets copies made in this realm.
    historique: {
      rechercher: (texte, limite, distinctes) => win.store.history.search(texte, limite, distinctes).then((v) => structuredClone(v)),
      recents: () => win.store.history.recent().then((v) => structuredClone(v)),
      effacer: (depuis) => win.store.history.clear(depuis),
      oublierTexte: (url, espaceId) => win.store.history.forgetText(url, espaceId),
    },
    // The list lives in the store's realm: the UI gets copies made in this realm.
    telechargements: {
      liste: async () => structuredClone(win.store.downloads.list()),
      ouvrir: (id) => win.store.downloads.open(id),
      montrer: (id) => win.store.downloads.show(id),
      annuler: (id) => win.store.downloads.cancel(id),
    },
    surTelechargements: (callback) => untilUnload(win.store.downloads.onChange((l) => callback(structuredClone(l)))),
    // The agent's cards and access badges live in the store's realm: the UI gets copies made in this realm.
    permissions: {
      enAttente: async () => structuredClone(win.store.questions.pending()),
      repondre: (id, d, _droits, o) => win.store.questions.answer(id, d, o),
    },
    surPermissions: (callback) => untilUnload(win.store.questions.onChange((l) => callback(structuredClone(l)))),
    acces: {
      etat: async () => structuredClone(win.store.access),
      couper: (id, droit) => host.notify("politique.couper", { id, droit }),
    },
    surAcces(callback) {
      const send = () => callback(structuredClone(win.store.access));
      const offAccess = host.on("acces", send);
      const offExit = host.on(HOST_EXITED, send);
      return untilUnload(() => {
        offAccess();
        offExit();
      });
    },
    // The home page: widgets, their data and state, and the agent's theme, all kept by the noyau host.
    accueil: {
      lire: async () => {
        let r: AccueilLu;
        try {
          r = structuredClone((await host.request<AccueilLu>("accueil.lire")) ?? { widgets: [], theme: null });
        } catch {
          // The host did not answer: an empty list is not evidence that the widgets are gone.
          return { widgets: [], theme: null };
        }
        await servirAffichages(r.widgets, win.store.dataDir, prepares);
        return r;
      },
      surChange: (rappel) => untilUnload(host.on("accueil.change", () => rappel())),
      placer: (placements) => host.notify("accueil.placer", { placements }),
      retirer: (id) => host.notify("accueil.retirer", { id }),
      ouvrir: (url, id) => {
        // Only just after a real click in this widget's display (one link per click), and one per second at most: a
        // display that would burst links could make data leave.
        if (!win.store.gestesWidgets.accepter(fenetre, id)) return console.warn("[webaios] lien de widget ignoré (pas de clic dans le widget) :", url);
        const maintenant = Date.now();
        if (maintenant - dernierLien < 1000) return console.warn("[webaios] lien de widget ignoré (trop rapproché) :", url);
        if (!urlOuvrable(url)) return console.warn("[webaios] lien de widget refusé :", url);
        dernierLien = maintenant;
        win.store.dispatch({ type: "ouvrirOnglet", fenetreId: fenetre, url, activer: true });
      },
      profilsPourAccord: async () => profilsPourAccord(win.store.state, fenetre),
      accorder: async (a) => {
        // The state is read again at the moment of the accord: never a private space's profile.
        if (!profilsLisibles(win.store.state).includes(a.profil)) return { ok: false as const, erreur: "Ce profil ne peut pas servir à un accord" };
        return host.request<{ ok: true } | { ok: false; erreur: string }>("accueil.accorder", a).then(
          (r) => structuredClone(r),
          (e) => ({ ok: false as const, erreur: e instanceof Error ? e.message : String(e) }),
        );
      },
      refuserAccord: (id) => host.notify("accueil.refuserAccord", { id }),
      recolter: (id) => host.notify("accueil.recolter", { id }),
      executions: (id) =>
        host.request<ResumeExecution[]>("accueil.executions", { id }).then(
          (v) => structuredClone(v),
          () => [],
        ),
      execution: (id, execution) =>
        host.request<Execution | null>("accueil.execution", { id, execution }).then(
          (v) => structuredClone(v),
          () => null,
        ),
    },
    // The command bar's sources besides tabs: none in step 2.
    applications: { liste: async () => ({ atelier: "ok", applications: [] }), surChange: off, agir() {} },
    sites: { liste: none, surChange: off, agir() {} },
    // The agent's extensions, kept by the noyau host: what the reused space modal, empty page and command bar call.
    extensions: {
      pourEspace: (espaceId) => host.request<LigneExtensionEspace[]>("extensions.pourEspace", { espaceId }).then((l) => structuredClone(l), () => []),
      basculer: (cle, espaceId, actif) => extension("extensions.basculer", { cle, espaceId, actif, fenetre }),
      surChange: (callback) => untilUnload(host.on("extensions.change", () => callback())),
      // The Extensions page: the agent's extensions only (decision 8); AMO add-ons stay in about:addons.
      liste: () => host.request<LigneExtension[]>("extensions.liste").then((l) => structuredClone(l), () => []),
      coupees: () => host.request<boolean>("extensions.coupees").then((b) => b === true, () => false),
      desactiverPartout: (cle) => extension("extensions.desactiverPartout", { cle }),
      supprimer: (cle) => extension("extensions.supprimer", { cle }),
      toutCouper: (oui) => extension("extensions.toutCouper", { oui }),
      revoir: (cle) => extension("extensions.revoir", { cle, fenetre }),
      reactiver: (cle) => extension("extensions.reactiver", { cle }),
      couperDeblocage: (cle) => extension("extensions.couperDeblocage", { cle }),
      installerStore: () => extension("extensions.installerStore", {}),
    } as Partial<ApiWebaios["extensions"]> as ApiWebaios["extensions"],
    actions: { liste: none, surChange: off, ouvrir: unavailable } as unknown as ApiWebaios["actions"],
  };
  return new Proxy(api, {
    get(target, key) {
      if (typeof key === "string" && !(key in target)) missing.add(key);
      return Reflect.get(target, key);
    },
  }) as ApiFirefox;
}
