import type { IdProfil } from "../../../navigateur/src/commun/modele";
import { profilsEnUsage } from "../../../navigateur/src/commun/modele";
import { chargerSession, EnregistreurSession } from "../../../navigateur/src/main/etat/persistance";
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
}

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
  };
}

export const ready: Promise<WebAiOsStore> = start();
