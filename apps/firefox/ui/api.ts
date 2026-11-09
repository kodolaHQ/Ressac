import type { ShownSite } from "../shared/sites";
import type { ApiWebaios, AgentPanelState, ApplicationList, ExtensionResult, ShownWidget } from "../shared/api";
import type { LigneExtension, SpaceExtensionLine } from "../shared/extensions";
import type { HomeTheme } from "../../../packages/noyau/src/accueil/theme.ts";
import type { FreePlacement } from "../../../packages/noyau/src/accueil/schemas.ts";
import type { Execution, ResumeExecution } from "../../../packages/noyau/src/workflows/executions.ts";
import { HOST_EXITED } from "../chrome/agent/host";
import { validFolder } from "../chrome/store/app-folder";
import type { WindowController } from "../chrome/window/controller";
import { forgetWidget, preparerWidget } from "../chrome/window/widget-frame";
import { profilsLisibles, profilsPourAccord, urlOuvrable } from "./accueil-profils";
import { ACTIONS_IN_PRIVATE_SPACE } from "../shared/actions";
import { createActionsApi, espaceActifPrive, type ActionsFirefox } from "./actions-api";
import { createDesignApi, createExternesApi, createRelectureApi } from "./design-api";

/** What the Firefox page reads: the widgets, plus the theme the ApiWebaios type does not carry. */
export interface AccueilLu {
  widgets: ShownWidget[];
  theme: HomeTheme | null;
}

/**
 * The UI's API, with the home page's read widened to carry the theme and free placements (Task 7), and
 * the actions' result images and components asked of the chrome.
 */
export interface ApiFirefox extends Omit<ApiWebaios, "accueil" | "actions"> {
  actions: ActionsFirefox;
  accueil: Omit<ApiWebaios["accueil"], "lire" | "placer"> & {
    lire(): Promise<AccueilLu>;
    placer(placements: FreePlacement[]): void;
    /** A real pointerdown in a widget's display, seen by the UI's chrome listener (not in the ApiWebaios type). */
    geste(id: string): void;
  };
  /** The design mode's cart column, opened or closed by App.svelte (ZoneContenu's rule), on the project of the active tab. */
  designVolet(ouvert: boolean): void;
  /** The cart column's « Fermer ». */
  surVoletFerme(callback: () => void): () => void;
}

declare global {
  interface Window {
    webaios: ApiFirefox;
    /** ApiWebaios members the UI reached that this api does not implement (read by the e2e). */
    webaiosMissingApi?: Set<string>;
  }
}

// Same text as noyau/host.ts's (a Node module this bundle cannot import).
const MESSAGE_AGENT_ARRETE = "Le service des widgets ne répond pas (agent arrêté ?)";

/**
 * Serves each widget's display: writes its sanitized copy under `<dataDir>/webaios-widgets/<id>/` and points `src` at
 * its resource:// URL. The widgets served last time and gone now lose their substitution and their copies.
 */
export async function servirAffichages(
  widgets: ShownWidget[],
  dataDir: string,
  prepares: Set<string>,
  outil: {
    preparer: (dataDir: string, id: string) => Promise<string | null>;
    oublier: (dataDir: string, id: string) => Promise<void>;
  } = { preparer: preparerWidget, oublier: forgetWidget },
): Promise<void> {
  const maintenant = new Set<string>();
  await Promise.all(
    widgets.map(async (w) => {
      if (!("src" in w) || w.src === null) return;
      const url = await outil.preparer(dataDir, w.id);
      w.src = url;
      if (url) maintenant.add(w.id);
    }),
  );
  for (const id of prepares) if (!maintenant.has(id)) await outil.oublier(dataDir, id);
  prepares.clear();
  for (const id of maintenant) prepares.add(id);
}

/**
 * `window.webaios`, on the Firefox window controller. What is not migrated yet (applications, sites,
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
  let lastSelection: unknown; // the last workflow.selection this window sent
  /** When this window last opened a widget link: a display cannot make links leave in a burst. */
  let dernierLien = 0;
  /** States this document makes itself: the host did not start, or stopped. */
  const localStates = new Set<(e: AgentPanelState) => void>();
  /** The widgets whose display this document prepared: the others' substitutions and copies are cleared. */
  const prepares = new Set<string>();
  const failed = (message: string) => localStates.forEach((cb) => cb({ etat: "erreur", message }));
  /** An extension action in the kernel host; its answer copied into this realm, a failure given back as text. */
  const extension = (method: string, params: Record<string, unknown>) =>
    host.request<ExtensionResult>(method, params).then((r) => structuredClone(r), (e) => ({ ok: false as const, erreur: e instanceof Error ? e.message : String(e) }));
  /** A host request answered in this realm; `fallback` when the host does not answer (no agent). */
  const ask = <T>(method: string, params: unknown, fallback: T): Promise<T> => host.request<T>(method, params).then((r) => structuredClone(r), () => fallback);
  /** An action's builder in a window whose active space is private (or unknown), read at the moment of asking. */
  const privateAction = (cible: { type: string }) => cible.type === "action" && (!win.store.state || espaceActifPrive(win.store.state, fenetre));
  const api: Partial<ApiFirefox> = {
    fenetreId: win.fenetreId,
    // A tab the user closes may ask first (beforeunload).
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
    surZoneGauche: (callback) => untilUnload(win.onLeftZone(callback)),
    // The window's terminal session, in the kernel host. Its output and states are routed by window.
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
    // The visits live in the kernel host: the UI gets copies made in this realm.
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
      repondre: (id, d, droits, o) => win.store.questions.answer(id, d, o, droits),
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
    // The home page: widgets, their data and state, and the agent's theme, all kept by the kernel host.
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
      geste: (id) => win.store.gestesWidgets.geste(fenetre, id),
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
        // The state is read again at the moment of the grant: never a private space's profile.
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
    // The agent's applications, kept by the kernel host (its windows through the chrome). The host checks every action
    // with SchemaActionApplication; « Afficher le dossier » is the chrome's (one path segment), « Relire » the UI's.
    applications: {
      liste: () => ask<ApplicationList>("applications.liste", undefined, { atelier: "ok", applications: [] }),
      surChange(callback) {
        // A host that started again, or the chrome's resync, sent no change: the list is read again.
        const offs = [host.on("applications.change", () => callback()), host.on(HOST_EXITED, () => callback()), host.on("accueil.change", () => callback())];
        return untilUnload(() => offs.forEach((f) => f()));
      },
      agir(dossier, action) {
        if (action === "dossier") return win.store.apps.reveal(dossier);
        // The app's Review page, under its name; a project without manifest has none.
        if (action === "relire") {
          if (!validFolder(dossier)) return;
          return void api.applications!.liste()
            .then((l) => {
              const a = l.applications.find((x) => x.dossier === dossier);
              if (a && a.type !== "sans-fiche") win.store.dispatch({ type: "ouvrirRelecture", fenetreId: fenetre, projet: "app-" + dossier, nom: a.nom.slice(0, 80) });
            })
            .catch((e) => console.error("[webaios] app review :", e));
        }
        // « Déboguer »: the host pre-fills the terminal and opens the panel (design.donnerAgent).
        host.notify("applications.agir", { dossier, action, fenetre });
      },
    },
    // The site apps, kept by the kernel host (its window actions go through the chrome); « Afficher le dossier » and
    // « Relire » are the UI's own.
    sites: {
      liste: () => ask<ShownSite[]>("sites.liste", undefined, []),
      surChange(callback) {
        // A host that started again, or the chrome's resync, sent no change: the list is read again.
        const offs = [host.on("sites.change", () => callback()), host.on(HOST_EXITED, () => callback()), host.on("accueil.change", () => callback())];
        return untilUnload(() => offs.forEach((f) => f()));
      },
      agir(id, action) {
        if (action === "dossier") return win.store.sites.revealSite(id);
        // The app's Review page, under its name.
        if (action === "relire")
          return void api.sites!.liste()
            .then((l) => win.store.dispatch({ type: "ouvrirRelecture", fenetreId: fenetre, projet: "site-" + id, nom: (l.find((s) => s.id === id)?.nom ?? id).slice(0, 80) }))
            .catch((e) => console.error("[webaios] site review :", e));
        host.notify("sites.agir", { id, action, fenetre });
        if (action === "modifier") win.openAgent();
      },
    },
    // The section « Projets externes »: the external MCP server, kept by the kernel host.
    externes: createExternesApi({ host, fenetre, dispatch: (a) => win.store.dispatch(a), untilUnload }),
    // The Review page: its comparisons and comments, kept by the kernel host.
    relecture: createRelectureApi({ host }),
    // The design mode of this window's tab; its cart column is a chrome frame (chrome/window/design-overlays.ts).
    design: createDesignApi({ win, untilUnload }),
    designVolet(ouvert) {
      const t = { type: "fenetre" as const, fenetreId: fenetre };
      if (ouvert === true) void win.store.design.openCart(t);
      else if (ouvert === false) win.store.design.closeOverlay(t, "panier");
    },
    surVoletFerme: (callback) => untilUnload(win.store.design.overlays.onColumnClosed({ type: "fenetre", fenetreId: fenetre }, () => callback())),
    // The agent's extensions, kept by the kernel host: what the reused space modal, empty page and command bar call.
    extensions: {
      pourEspace: (espaceId) => host.request<SpaceExtensionLine[]>("extensions.pourEspace", { espaceId }).then((l) => structuredClone(l), () => []),
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
    // The workflow builder: its reads and writes in the kernel host. An action's is refused in a private space with the
    // shapes of the builder's answers; its reads are checked again once answered.
    workflow: {
      catalogue: () => ask("workflow.catalogue", undefined, []),
      lire: async (cible) => (privateAction(cible) ? null : ask("workflow.lire", { cible }, null).then((r) => (privateAction(cible) ? null : r))),
      enregistrer: async (cible, brouillon) =>
        privateAction(cible)
          ? { ok: false, erreur: ACTIONS_IN_PRIVATE_SPACE, avertissements: [] }
          : ask("workflow.enregistrer", { cible, brouillon }, { ok: false, erreur: MESSAGE_AGENT_ARRETE, avertissements: [] }),
      lireCode: async (cible, nom) =>
        privateAction(cible)
          ? { erreur: ACTIONS_IN_PRIVATE_SPACE }
          : ask("workflow.lireCode", { cible, nom }, { erreur: MESSAGE_AGENT_ARRETE }).then((r) => (privateAction(cible) ? { erreur: ACTIONS_IN_PRIVATE_SPACE } : r)),
      enregistrerCode: async (cible, nom, texte) =>
        privateAction(cible) ? { ok: false, erreur: ACTIONS_IN_PRIVATE_SPACE } : ask("workflow.enregistrerCode", { cible, nom, texte }, { ok: false, erreur: MESSAGE_AGENT_ARRETE }),
      rejouer: async (cible, execution, bloc) =>
        privateAction(cible) ? { ok: false, erreur: ACTIONS_IN_PRIVATE_SPACE } : ask("workflow.rejouer", { cible, execution, bloc }, { ok: false, erreur: MESSAGE_AGENT_ARRETE }),
      lancer: async (cible, saisie) => (privateAction(cible) ? { erreur: ACTIONS_IN_PRIVATE_SPACE } : ask("workflow.lancer", { cible, saisie: saisie ?? null }, {})),
      selection(cible, bloc) {
        // The host keeps it in memory only: resent on `acces`, which a host sends once its kernel has started (and on policy
        // changes, harmless: the same selection again).
        if (!lastSelection) untilUnload(host.on("acces", () => host.notify("workflow.selection", lastSelection)));
        lastSelection = { fenetre, cible, bloc };
        host.notify("workflow.selection", lastSelection);
      },
      direct: () => ask("workflow.direct", undefined, { courants: [], enAttente: [] }),
      surDirect(callback) {
        // A host that stopped or started again sent no feed meanwhile: the runs are read again.
        const again = () => void api.workflow!.direct().then(callback);
        const offs = [host.on("workflow.direct", (e) => callback(structuredClone(e))), host.on(HOST_EXITED, again), host.on("accueil.change", again)];
        return untilUnload(() => offs.forEach((f) => f()));
      },
    },
    // The actions: the window state's half here (private spaces, dispatches), the disk and kernel's in the host.
    actions: createActionsApi({ state: () => win.store.state, dispatch: (a) => win.store.dispatch(a), host, fenetre, untilUnload, media: win.store.actionMedia }),
  };
  return new Proxy(api, {
    get(target, key) {
      if (typeof key === "string" && !(key in target)) missing.add(key);
      return Reflect.get(target, key);
    },
  }) as ApiFirefox;
}
