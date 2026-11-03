import type { EtatAcces, IdProfil } from "../../../navigateur/src/commun/modele";
import { profilsEnUsage } from "../../../navigateur/src/commun/modele";
import { chargerSession, EnregistreurSession } from "../../../navigateur/src/main/etat/persistance";
import { bridgeHandlers, sendMirror, trackState } from "../agent/bridge";
import { createHost, HOST_EXITED, type AgentHost } from "../agent/host";
import { Questions } from "../agent/questions";
import { containerFor, removeContainer } from "./containers";
import { createStore, type Store } from "./store";

const { AsyncShutdown } = ChromeUtils.importESModule("resource://gre/modules/AsyncShutdown.sys.mjs");

export interface WebAiOsStore extends Store {
  readonly dataDir: string;
  /** Where an unreadable session was set aside at startup, or null. */
  readonly setAside: string | null;
  flush(): Promise<void>;
  /** userContextId of a login profile: 0 for PROFIL_DEFAUT, a container named `webaios-<id>` otherwise (created on first use). */
  containerFor(profile: IdProfil): number;
  /** The Node host running the noyau, started with the store. */
  readonly agent: AgentHost;
  /** The agent's « lire l'onglet » cards waiting for an answer. */
  readonly questions: Questions;
  /** The agent's access to tabs, as the host last sent it (no access while no host runs). */
  readonly access: EtatAcces;
}

const PAGE_ACTOR = "chrome://browser/content/webaios/page-actor.sys.mjs";

const dataDir =
  Services.env.get("WEBAIOS_DATA_DIR") || PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, "WebAiOs-firefox", "data");

async function start(): Promise<WebAiOsStore> {
  let setAside: string | null = null;
  const store = createStore(await chargerSession(dataDir, (p) => (setAside = p)));
  const recorder = new EnregistreurSession(dataDir);
  const flush = () => recorder.vider();
  store.subscribe((state, previous) => {
    recorder.planifier(state);
    const used = profilsEnUsage(state);
    for (const id of profilsEnUsage(previous)) if (!used.has(id)) {
        try {
          removeContainer(id);
        } catch (e) {
          console.error("[store] container removal failed:", e);
        }
      }
  });
  AsyncShutdown.profileBeforeChange.addBlocker("WebAiOs: save the session", flush);
  ChromeUtils.registerWindowActor("WebAiOsPage", {
    parent: { esModuleURI: PAGE_ACTOR },
    child: { esModuleURI: PAGE_ACTOR },
    matches: ["http://*/*", "https://*/*", "file:///*"],
    // The child only reads and answers: nothing a compromised web process sends can make the parent act.
    safeForUntrustedWebProcess: true,
    messageManagerGroups: ["browsers", "webaios-reading"],
  });
  const questions = new Questions(store);
  const agent = createHost({
    dataDir,
    profilAgent: () => store.state.reglages.profilAgent,
    handlers: bridgeHandlers(store, questions),
    onStart: (notify) => sendMirror(store, notify),
  });
  trackState(store, agent);
  // Registered before any UI listener: the UI reads `access` once it is updated.
  let access: EtatAcces = { agent: "L'agent", onglets: {} };
  agent.on("acces", (e: EtatAcces) => (access = e));
  agent.on(HOST_EXITED, () => (access = { agent: access.agent, onglets: {} }));
  agent.ensure().catch((e) => console.error("[agent] the noyau did not start:", e));
  // No `node … host.ts` may outlive the app: its sessions and MCP server stop with it.
  AsyncShutdown.profileBeforeChange.addBlocker("WebAiOs: stop the agent host", () => agent.stop());
  return {
    get state() {
      return store.state;
    },
    dispatch: store.dispatch,
    subscribe: store.subscribe,
    dataDir,
    setAside,
    flush,
    containerFor,
    agent,
    questions,
    get access() {
      return access;
    },
  };
}

export const ready: Promise<WebAiOsStore> = start();
