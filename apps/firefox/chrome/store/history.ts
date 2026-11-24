import { historyContext, type TabId, type Visit } from "../../shared/model";
import { spacesBecamePrivate } from "../../core/agent/bridge";
import type { AgentHost } from "../agent/host";
import type { Store } from "./store";

export interface History {
  /**
   * A committed top-level navigation of a Ressac tab; private, space and byAgent read from the state now. http(s) only.
   * `byAgent`: the tab was the agent's when the visit happened (a held note), whatever it is now.
   */
  visit(id: TabId, url: string, title: string, byAgent?: boolean): void;
  title(id: TabId, url: string, title: string): void;
  /** The tab's favicon (data:image/ only), kept per site for the ⌘T rows; never from a private space. */
  icon(id: TabId, url: string, icon: string): void;
  /** The agent's memory of a page: dropped by the kernel for a private visit or a loopback URL. `byAgent`: read in a tab the agent reached. */
  retain(r: { url: string; spaceId: string; title: string; text: string; byAgent: boolean }): void;
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
    for (const spaceId of spacesBecamePrivate(previous, state)) host.notify("history.makePrivate", { spaceId: spaceId });
  });
  const context = (id: TabId, url: string) => (historizable(url) ? historyContext(store.state, id) : null);
  const ask = <T>(method: string, params: unknown, none: T) => host.request<T>(method, params).catch(() => none);
  return {
    visit(id, url, title, byAgent) {
      const c = context(id, url);
      if (c) host.notify("history.record", { url, title: title || url, ...c, byAgent: c.byAgent || !!byAgent });
    },
    title(id, url, title) {
      const c = context(id, url);
      if (c) host.notify("history.title", { url, spaceId: c.spaceId, title: title });
    },
    icon(id, url, icon) {
      const c = context(id, url);
      if (c && !c.private && icon.startsWith("data:image/")) host.notify("history.icon", { url, spaceId: c.spaceId, icon: icon });
    },
    retain: (r) => host.notify("history.keep", r),
    search: (text, limit, distinct) => ask("history.search", { text: text, limit: limit, distinct: distinct }, []),
    recent: () => ask("history.recent", {}, []),
    clear: (from) => ask("history.clear", { since: from }, undefined),
    forgetText: (url, spaceId) => ask("history.forgetText", { url, spaceId: spaceId }, undefined),
  };
}
