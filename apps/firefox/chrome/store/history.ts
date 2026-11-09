import { historyContext, type TabId, type Visite } from "../../shared/model";
import { spacesBecamePrivate } from "../../core/agent/pont";
import type { AgentHost } from "../agent/host";
import type { Store } from "./store";

export interface History {
  /** A committed top-level navigation of a WebAiOs tab; private and space read from the state now. http(s) only. */
  visit(id: TabId, url: string, titre: string): void;
  title(id: TabId, url: string, titre: string): void;
  /** The agent's memory of a page: dropped by the kernel for a private visit or a loopback URL. */
  retain(r: { url: string; espaceId: string; titre: string; texte: string }): void;
  /** Never rejects: [] while the host is down. */
  search(text: string, limit?: number, distinct?: boolean): Promise<Visite[]>;
  recent(): Promise<Visite[]>;
  clear(from?: string): Promise<void>;
  forgetText(url: string, spaceId: string): Promise<void>;
}

const historizable = (url: string) => /^https?:\/\//.test(url);

/** The visits live in the kernel host, which owns the SQLite file. */
export function createHistory(store: Store, host: AgentHost): History {
  // A space turned private keeps its visits but marks them, even while no agent runs.
  store.subscribe((state, previous) => {
    for (const spaceId of spacesBecamePrivate(previous, state)) host.notify("historique.rendrePrive", { espaceId: spaceId });
  });
  const context = (id: TabId, url: string) => (historizable(url) ? historyContext(store.state, id) : null);
  const ask = <T>(method: string, params: unknown, none: T) => host.request<T>(method, params).catch(() => none);
  return {
    visit(id, url, titre) {
      const c = context(id, url);
      if (c) host.notify("historique.noter", { url, titre: titre || url, ...c });
    },
    title(id, url, titre) {
      const c = context(id, url);
      if (c) host.notify("historique.titre", { url, espaceId: c.espaceId, titre });
    },
    retain: (r) => host.notify("historique.retenir", r),
    search: (text, limit, distinct) => ask("historique.rechercher", { texte: text, limite: limit, distinctes: distinct }, []),
    recent: () => ask("historique.recents", {}, []),
    clear: (from) => ask("historique.effacer", { depuis: from }, undefined),
    forgetText: (url, spaceId) => ask("historique.oublierTexte", { url, espaceId: spaceId }, undefined),
  };
}
