import { contexteHistorique, type IdOnglet, type Visite } from "../../shared/modele";
import { espacesDevenusPrives } from "../../core/agent/pont";
import type { AgentHost } from "../agent/host";
import type { Store } from "./store";

export interface History {
  /** A committed top-level navigation of a WebAiOs tab; private and space read from the state now. http(s) only. */
  visit(id: IdOnglet, url: string, titre: string): void;
  title(id: IdOnglet, url: string, titre: string): void;
  /** The agent's memory of a page: dropped by the noyau for a private visit or a loopback URL. */
  retain(r: { url: string; espaceId: string; titre: string; texte: string }): void;
  /** Never rejects: [] while the host is down. */
  search(texte: string, limite?: number, distinctes?: boolean): Promise<Visite[]>;
  recent(): Promise<Visite[]>;
  clear(depuis?: string): Promise<void>;
  forgetText(url: string, espaceId: string): Promise<void>;
}

const historisable = (url: string) => /^https?:\/\//.test(url);

/** Electron's history wiring (evenements.ts, index.ts): the visits live in the noyau host, which owns the SQLite file. */
export function createHistory(store: Store, host: AgentHost): History {
  // A space turned private keeps its visits but marks them, even while no agent runs.
  store.subscribe((state, previous) => {
    for (const espaceId of espacesDevenusPrives(previous, state)) host.notify("historique.rendrePrive", { espaceId });
  });
  const context = (id: IdOnglet, url: string) => (historisable(url) ? contexteHistorique(store.state, id) : null);
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
    search: (texte, limite, distinctes) => ask("historique.rechercher", { texte, limite, distinctes }, []),
    recent: () => ask("historique.recents", {}, []),
    clear: (depuis) => ask("historique.effacer", { depuis }, undefined),
    forgetText: (url, espaceId) => ask("historique.oublierTexte", { url, espaceId }, undefined),
  };
}
