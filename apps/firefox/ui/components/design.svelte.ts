import type { DesignState } from "../../shared/api";
import { api } from "../state.svelte";

/**
 * The design mode of the tab shown in this window (re-read on each broadcast change, and when the tab or its address
 * changes), and the basket requested by « Panier » (open even outside the mode).
 */
export const design = $state<{ etat: DesignState | null; panierDemande: boolean }>({ etat: null, panierDemande: false });

let request = 0;
export async function rereadDesign(): Promise<void> {
  const n = ++request;
  try {
    const e = await api.design.etat();
    if (n === request) design.etat = e;
  } catch {
    // Main process not ready: the next broadcast will re-read.
  }
}

api.design.surChange(() => void rereadDesign());
