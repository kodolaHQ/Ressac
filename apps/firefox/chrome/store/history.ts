import { historyContext, type TabId, type Visit } from "../../shared/model";
import { spacesBecamePrivate } from "../../core/agent/bridge";
import type { AgentHost } from "../agent/host";
import type { Store } from "./store";

export interface History {
  /** A committed top-level navigation of a WebAiOs tab; private and space read from the state now. http(s) only. */
  visit(id: TabId, url: string, title: string): void;
  title(id: TabId, url: string, title: string): void;
  /** The agent's memory of a page: dropped by the kernel for a private visit or a loopback URL. */
  retain(r: { url: string; spaceId: string; title: string; text: string }): void;
  /** Never rejects: [] while the host is down. */
  search(text: string, limit?: number, distinct?: boolean): Promise<Visit[]>;
  recent(): Promise<Visit[]>;
  clear(from?: string): Promise<void>;
  forgetText(url: string, spaceId: string): Promise<void>;
}

const historizable = (url: string) => /^https?:\/\//.test(url);

/** The visits live in the kernel host, which owns the SQLite file. */
export function createHistory(store: Store, host: AgentHost): History {
  // A space turned private keeps its visits but marks them, even while no agent runs.
  store.subscribe((state, previous) => {
    for (const spaceId of spacesBecamePrivate(previous, state)) host.notify("historique.rendrePrive", { spaceId: spaceId });
  });
  const context = (id: TabId, url: string) => (historizable(url) ? historyContext(store.state, id) : null);
  const ask = <T>(method: string, params: unknown, none: T) => host.request<T>(method, params).catch(() => none);
  return {
    visit(id, url, title) {
      const c = context(id, url);
      if (c) host.notify("historique.noter", { url, title: title || url, ...c });
    },
    title(id, url, title) {
      const c = context(id, url);
      if (c) host.notify("historique.titre", { url, spaceId: c.spaceId, title: title });
    },
    retain: (r) => host.notify("historique.retenir", r),
    search: (text, limit, distinct) => ask("historique.rechercher", { text: text, limit: limit, distinct: distinct }, []),
    recent: () => ask("historique.recents", {}, []),
    clear: (from) => ask("historique.effacer", { since: from }, undefined),
    forgetText: (url, spaceId) => ask("historique.oublierTexte", { url, spaceId: spaceId }, undefined),
  };
}
