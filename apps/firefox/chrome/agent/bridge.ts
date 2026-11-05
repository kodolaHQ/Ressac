import { OngletIntrouvable, OngletPrive, type DroitDev, type OngletInfo, type OptionsLecturePage } from "../shims/noyau";
import type { EtatNavigateur, IdFenetre, Onglet } from "../../../navigateur/src/commun/modele";
import { ongletPrive, PREFIXE_WORKFLOW } from "../../../navigateur/src/commun/modele";
import { changementsPolitique, infosOnglets, ongletActifDe, origineDe, resoudreEspace } from "../../../navigateur/src/main/agent/pont";
import type { Handler } from "../../shared/rpc";
import type { DevTools } from "../store/devtools";
import type { Store } from "../store/store";
import type { WindowRegistry } from "../store/windows";
import type { AgentHost } from "./host";
import { readHtml, readPage } from "./invisible";
import type { Questions } from "./questions";

const XHTML = "http://www.w3.org/1999/xhtml";
/** As the page actor and Electron. */
const TEXT_MAX = 100_000;

const internal = (o: Onglet) => o.url.startsWith("webaios:");

/** What the host's bridge mirrors for its two synchronous methods (estPrive, ongletActifPrive). */
function privateMirror(state: EtatNavigateur, windows: WindowRegistry): { prives: string[]; actifPrive: boolean } {
  const isPrivate = (o: Onglet | undefined) => !!o && !internal(o) && ongletPrive(state, o);
  const f = state.fenetres.find((x) => x.id === windows.active());
  const active = f && f.actif[f.espaceActif];
  return { prives: Object.values(state.onglets).filter(isPrivate).map((o) => o.id), actifPrive: isPrivate(active ? state.onglets[active] : undefined) };
}

/** Each window's active tab URL, for `workflow_ouvert`: only a workflow page, never a web URL (null otherwise). */
function activeWorkflows(state: EtatNavigateur): Record<IdFenetre, string | null> {
  const r: Record<IdFenetre, string | null> = {};
  for (const f of state.fenetres) {
    const url = state.onglets[f.actif[f.espaceActif] ?? ""]?.url;
    r[f.id] = url?.startsWith(PREFIXE_WORKFLOW) ? url : null;
  }
  return r;
}

/** The noyau's PontNavigateur, answered on the store and the windows' tabs (Electron's PontElectron). */
export function bridgeHandlers(store: Store, questions: Questions, windows: WindowRegistry, devtools: DevTools, host: () => AgentHost): Record<string, Handler> {
  /** The open window that holds the tab. */
  const windowOf = (id: string) => {
    const m = windows.get(store.state.onglets[id]?.fenetreId ?? "");
    if (!m) throw new Error("Aucune fenêtre ouverte");
    return m;
  };
  /** Throws OngletPrive for a tab in a private space: a call that crosses the switch to private reads nothing. */
  const tab = (id: string): Onglet => {
    const state = store.state;
    const o = state.onglets[id];
    if (!o) throw new OngletIntrouvable(id);
    if (ongletPrive(state, o)) throw new OngletPrive(id);
    return o;
  };
  /** A tab whose page can be read: Firefox's crash or error page is not the page. */
  const loadedTab = (id: string): Onglet => {
    const o = tab(id);
    if (o.plante) throw new Error("La page a planté : rechargez-la.");
    if (o.erreur) throw new Error("La page n'a pas pu être chargée.");
    return o;
  };
  /**
   * Reads the tab's page (its XUL tab created in the background and loaded if needed), then checks the tab did not
   * become private nor go to another origin meanwhile: access was checked on the URL from before.
   */
  const outsidePrivate = async <T>(id: string, read: (browser: any) => Promise<T>): Promise<T> => {
    const before = loadedTab(id);
    const browser = await windowOf(id).controller.ensure(id);
    loadedTab(id); // crashed or failed while it loaded
    const r = await read(browser);
    const origin = origineDe(before.url);
    if (origineDe(tab(id).url) !== origin || origineDe(browser.currentURI.spec) !== origin)
      throw new Error("L'onglet a changé de site pendant la lecture : rien n'est rendu.");
    return r;
  };

  return {
    // Decision 3, as Electron's fenetreAgent: no window open (the last one kept), no active tab.
    ongletActif: ([fenetre]: [IdFenetre?] = []) => ongletActifDe(store.state, fenetre ?? windows.active()),
    listerOnglets: () => infosOnglets(store.state),
    // The agent's demos open in the foreground, marked ✦. With no window open, in the kept one, as Electron.
    ouvrirOnglet: ([url, espace]: [string, string?]): OngletInfo => {
      const state = store.state;
      const f = state.fenetres.find((x) => x.id === windows.active()) ?? state.fenetres[0];
      if (!f) throw new Error("Aucune fenêtre ouverte");
      const espaceId = resoudreEspace(state, f, espace);
      if (state.espaces.find((e) => e.id === espaceId)?.prive ?? true) throw new Error("Impossible d'ouvrir un onglet ici : l'espace actif est privé.");
      const id = crypto.randomUUID();
      store.dispatch({ type: "ouvrirOnglet", fenetreId: f.id, url, espaceId, activer: true, ouvertParAgent: true }, () => id);
      if (!store.state.onglets[id]) throw new Error(`Impossible d'ouvrir ${url}`);
      store.dispatch({ type: "activerOnglet", id }); // also switches to its space
      return infosOnglets(store.state).find((o) => o.id === id)!;
    },
    naviguer: ([id, url]: [string, string]) => {
      tab(id);
      windowOf(id).controller.navigateForAgent(id, url);
    },
    lireTexte: ([id]: [string]) =>
      outsidePrivate(id, async (browser) => {
        const r = await browser.browsingContext.currentWindowGlobal.getActor("WebAiOsPage").sendQuery("getText");
        // The child runs in a web process: its answer is not trusted.
        const texte = String(r?.texte ?? "").slice(0, TEXT_MAX);
        const selection = String(r?.selection ?? "").slice(0, TEXT_MAX);
        return selection ? { texte, selection } : { texte };
      }),
    capturer: ([id]: [string]) =>
      outsidePrivate(id, async (browser) => {
        const bitmap = await browser.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
        try {
          const canvas = windowOf(id).window.document.createElementNS(XHTML, "canvas") as HTMLCanvasElement;
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
          return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
        } finally {
          bitmap.close();
        }
      }),
    // « L'agent veut lire l'onglet … » in the active window; refused with none to show it. The signal aborts when the
    // host goes: the card falls.
    demanderAutorisation: ([o]: [OngletInfo], signal) => {
      const f = windows.active();
      return f ? questions.ask(o, f, signal) : false;
    },
    // The dev tools card, in the active window; refused with none to show it. The noyau takes it down (signal) when a
    // new conversation starts.
    demanderOutilsDev: ([o, d]: [OngletInfo, { droits: DroitDev[]; raison: string; agent: string }], signal) => {
      const f = windows.active();
      return f ? questions.askDevTools(o, d, f, signal) : [];
    },
    lirePageInvisible: ([url, o]: [string, OptionsLecturePage & { menagee?: string }], signal) =>
      readPage(store, url, o, signal, (lecture, hote, s) => host().request("lecture.changerHote", { lecture, hote }, s)),
    lireHtmlInvisible: ([url, o]: [string, { adressesLocales?: boolean }], signal) => readHtml(store, url, o ?? {}, signal),
    // The noyau's dev tools (RemoteBridge.outilsDev): one owner per noyau start, its token on every call.
    "outilsDev.owner": () => devtools.owner(),
    "outilsDev.call": ([token, method, args]: Parameters<DevTools["call"]>, signal) => devtools.call(token, method, args, signal),
    "outilsDev.release": ([token]: [string]) => devtools.release(String(token)),
  };
}

/**
 * Tells the host what the access policy and the private mirror must learn from each state change. Returns the mirror's
 * refresh, for what moves the active window without a state change (focus, a window closing).
 */
export function trackState(store: Store, host: AgentHost, windows: WindowRegistry): () => void {
  let mirror = JSON.stringify(privateMirror(store.state, windows));
  let workflows = JSON.stringify(activeWorkflows(store.state));
  const refresh = () => {
    const next = JSON.stringify(privateMirror(store.state, windows));
    if (next !== mirror) host.notify("prives", JSON.parse((mirror = next)));
    const nextWorkflows = JSON.stringify(activeWorkflows(store.state));
    if (nextWorkflows !== workflows) host.notify("fenetres.actives", JSON.parse((workflows = nextWorkflows)));
  };
  store.subscribe((state, previous) => {
    refresh();
    const { navigues, fermes } = changementsPolitique(previous, state);
    for (const n of navigues) host.notify("politique.navigue", n);
    for (const id of fermes) host.notify("politique.ferme", { id });
    // Opening the agent panel on a tab gives it to the agent and pre-fills its context (Electron's agent.ts).
    for (const f of state.fenetres) {
      const opened = f.panneauAgentOuvert && !previous.fenetres.find((x) => x.id === f.id)?.panneauAgentOuvert;
      const onglet = opened && ongletActifDe(state, f.id);
      if (onglet) host.notify("agent.panneauOuvert", { fenetre: f.id, onglet });
    }
    if (state.reglages.profilAgent !== previous.reglages.profilAgent)
      host.request("changerProfil", { profilAgent: state.reglages.profilAgent }).catch((e) => console.error("[agent] profile change failed:", e));
  });
  return refresh;
}

/** The private and workflow mirrors a new host starts from. */
export const sendMirror = (store: Store, windows: WindowRegistry, notify: (method: string, params: unknown) => void) => {
  notify("prives", privateMirror(store.state, windows));
  notify("fenetres.actives", activeWorkflows(store.state));
};
