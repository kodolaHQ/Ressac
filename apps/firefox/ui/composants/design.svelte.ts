import type { EtatDesign } from "../../shared/api";
import { api } from "../etat.svelte";

/**
 * The design mode of the tab shown in this window (re-read on each broadcast change, and when the tab or its address
 * changes), and the basket requested by « Panier » (open even outside the mode).
 */
export const design = $state<{ etat: EtatDesign | null; panierDemande: boolean }>({ etat: null, panierDemande: false });

let requete = 0;
export async function relireDesign(): Promise<void> {
  const n = ++requete;
  try {
    const e = await api.design.etat();
    if (n === requete) design.etat = e;
  } catch {
    // Main process not ready: the next broadcast will re-read.
  }
}

api.design.surChange(() => void relireDesign());
