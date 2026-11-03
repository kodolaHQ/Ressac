import { OngletIntrouvable, OngletPrive, type OngletInfo } from "../shims/noyau";
import type { EtatNavigateur, IdFenetre, Onglet } from "../../../navigateur/src/commun/modele";
import { ongletPrive } from "../../../navigateur/src/commun/modele";
import { changementsPolitique, infosOnglets, ongletActifDe, origineDe, resoudreEspace } from "../../../navigateur/src/main/agent/pont";
import type { Handler } from "../../shared/rpc";
import type { Store } from "../store/store";
import type { WindowController } from "../window/controller";
import type { AgentHost } from "./host";
import type { Questions } from "./questions";

const XHTML = "http://www.w3.org/1999/xhtml";
/** As the page actor and Electron. */
const TEXT_MAX = 100_000;

/** The main WebAiOs window and its controller, if one is open (macOS keeps running without a window). */
export function mainWindow(): { window: Window; controller: WindowController } | undefined {
  for (const w of Services.wm.getEnumerator("navigator:browser"))
    if (w.document.documentElement.hasAttribute("webaios-main") && w.webaiosWindow) return { window: w, controller: w.webaiosWindow };
  return undefined;
}

function needWindow() {
  const m = mainWindow();
  if (!m) throw new Error("Aucune fenêtre ouverte");
  return m;
}

const internal = (o: Onglet) => o.url.startsWith("webaios:");
const activeWindow = (state: EtatNavigateur): IdFenetre | undefined => mainWindow()?.controller.fenetreId ?? state.fenetres[0]?.id;

/** What the host's bridge mirrors for its two synchronous methods (estPrive, ongletActifPrive). */
function privateMirror(state: EtatNavigateur): { prives: string[]; actifPrive: boolean } {
  const isPrivate = (o: Onglet | undefined) => !!o && !internal(o) && ongletPrive(state, o);
  const f = state.fenetres.find((x) => x.id === activeWindow(state));
  const active = f && f.actif[f.espaceActif];
  return { prives: Object.values(state.onglets).filter(isPrivate).map((o) => o.id), actifPrive: isPrivate(active ? state.onglets[active] : undefined) };
}

/** The noyau's PontNavigateur, answered on the store and the tabs of the main window (Electron's PontElectron). */
export function bridgeHandlers(store: Store, questions: Questions): Record<string, Handler> {
  /** Throws OngletPrive for a tab in a private space: a call that crosses the switch to private reads nothing. */
  const tab = (id: string): Onglet => {
    const state = store.state;
    const o = state.onglets[id];
    if (!o) throw new OngletIntrouvable(id);
    if (ongletPrive(state, o)) throw new OngletPrive(id);
    return o;
  };
  /**
   * Reads the tab's page (its XUL tab created in the background and loaded if needed), then checks the tab did not
   * become private nor go to another origin meanwhile: access was checked on the URL from before.
   */
  const outsidePrivate = async <T>(id: string, read: (browser: any) => Promise<T>): Promise<T> => {
    const before = tab(id);
    const browser = await needWindow().controller.ensure(id);
    const r = await read(browser);
    const origin = origineDe(before.url);
    if (origineDe(tab(id).url) !== origin || origineDe(browser.currentURI.spec) !== origin)
      throw new Error("L'onglet a changé de site pendant la lecture : rien n'est rendu.");
    return r;
  };

  return {
    ongletActif: ([fenetre]: [IdFenetre?] = []) => ongletActifDe(store.state, fenetre ?? activeWindow(store.state)),
    listerOnglets: () => infosOnglets(store.state),
    // The agent's demos open in the foreground, marked ✦.
    ouvrirOnglet: ([url, espace]: [string, string?]): OngletInfo => {
      const state = store.state;
      const f = state.fenetres.find((x) => x.id === activeWindow(state)) ?? state.fenetres[0];
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
      needWindow().controller.navigateForAgent(id, url);
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
          const canvas = needWindow().window.document.createElementNS(XHTML, "canvas") as HTMLCanvasElement;
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
          return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
        } finally {
          bitmap.close();
        }
      }),
    // « L'agent veut lire l'onglet … » in the active window. The signal aborts when the host goes: the card falls.
    demanderAutorisation: ([o]: [OngletInfo], signal) => {
      const f = activeWindow(store.state);
      return f ? questions.ask(o, f, signal) : false;
    },
    lirePageInvisible: () => {
      throw new Error("Lecture invisible indisponible");
    },
    lireHtmlInvisible: () => {
      throw new Error("Lecture invisible indisponible");
    },
  };
}

/** Tells the host what the access policy and the private mirror must learn from each state change. */
export function trackState(store: Store, host: AgentHost): void {
  let mirror = JSON.stringify(privateMirror(store.state));
  store.subscribe((state, previous) => {
    const next = JSON.stringify(privateMirror(state));
    if (next !== mirror) host.notify("prives", JSON.parse((mirror = next)));
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
}

/** The private mirror a new host starts from. */
export const sendMirror = (store: Store, notify: (method: string, params: unknown) => void) => notify("prives", privateMirror(store.state));
