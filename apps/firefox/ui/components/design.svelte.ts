import type { DesignState } from "../../shared/api";
import { api } from "../state.svelte";

/**
 * The design mode of the tab shown in this window (re-read on each broadcast change and when the tab or its address
 * changes; App.svelte subscribes, not this module: the overlay and pill frames load this bundle
 * too), and the basket requested by « Panier » (open even outside the mode).
 */
export const design = $state<{ state: DesignState | null; basketRequested: boolean }>({ state: null, basketRequested: false });

let request = 0;
export async function rereadDesign(): Promise<void> {
  const n = ++request;
  try {
    const e = await api.design.state();
    if (n === request) design.state = e;
  } catch {
    // Main process not ready: the next broadcast will re-read.
  }
}
