import type { DirectWidget } from "@webaios/noyau";

export type Pastille = { statut: string; elements: number | null };

/**
 * Statut de chaque bloc : celui de l'exécution choisie (complète ou résumée), remplacé par le direct pour les blocs en
 * cours.
 */
export function pastillesDe(execution: { blocs: { id: string; statut: string; elements: number | null }[] } | null, direct: DirectWidget | null): Record<string, Pastille> {
  const sortie: Record<string, Pastille> = {};
  for (const b of execution?.blocs ?? []) sortie[b.id] = { statut: b.statut, elements: b.elements };
  for (const [id, b] of Object.entries(direct?.blocs ?? {})) sortie[id] = { statut: b.statut, elements: b.elements };
  return sortie;
}
