import type { EtatDesign } from "../../commun/api";
import { api } from "../etat.svelte";

/**
 * Le mode design de l'onglet affiché dans cette fenêtre (relu à chaque changement diffusé, et quand l'onglet ou son
 * adresse change), et le panier demandé par « Panier » (ouvert même hors du mode).
 */
export const design = $state<{ etat: EtatDesign | null; panierDemande: boolean }>({ etat: null, panierDemande: false });

let requete = 0;
export async function relireDesign(): Promise<void> {
  const n = ++requete;
  try {
    const e = await api.design.etat();
    if (n === requete) design.etat = e;
  } catch {
    // Process principal pas prêt : la prochaine diffusion relira.
  }
}

api.design.surChange(() => void relireDesign());
