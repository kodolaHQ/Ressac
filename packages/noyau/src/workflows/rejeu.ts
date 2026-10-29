import type { Execution } from "./executions.js";
import type { WorkflowValide } from "./valider.js";

export const PREFIXE_REJEU = "Rejeu impossible : ";
/** Refus quand la ligne de début d'un rejeu dépasse 4 Mo (mesurée par `debutTropGros`, avant tout lancement). */
export const REJEU_TROP_GROS = `${PREFIXE_REJEU}les sorties à reprendre dépassent 4 Mo`;

export type PlanRejeu =
  | { ok: true; relances: string[]; sorties: Record<string, unknown>; repris: Record<string, number | null>; origine: string }
  | { ok: false; erreur: string };

/** Combien d'exécutions un rejeu remonte au plus pour trouver une sortie reprise (essai d'essai d'essai…). */
export const PROFONDEUR_REJEU = 8;

/**
 * Ce qu'un rejeu depuis `depart` relance (le bloc et tous ses descendants, dans l'ordre d'exécution) et ce qu'il
 * reprend de l'exécution d'origine (la sortie des prédécesseurs des blocs relancés qui ne le sont pas). Quand
 * l'origine est un essai, ses blocs `repris` n'ont pas de sortie : elle se prend dans `anterieures`, la chaîne de ses
 * origines (`anterieures[0]` est `origine.essai.origine`, et ainsi de suite). `origine` du plan nomme l'exécution d'où
 * viennent toutes les sorties reprises quand il n'y en a qu'une, sinon l'origine donnée. Pur : aucune lecture de
 * fichier, la taille de ce qui est repris se mesure à part (`debutTropGros`).
 */
export function planRejeu(valide: WorkflowValide, origine: Execution | null, depart: string, anterieures: Execution[] = []): PlanRejeu {
  const refus = (cause: string): PlanRejeu => ({ ok: false, erreur: PREFIXE_REJEU + cause });
  if (!origine) return refus("exécution introuvable");
  if (!valide.ordre.includes(depart)) return refus(`le bloc « ${depart} » n'est pas dans le workflow`);

  const suivants = new Map<string, string[]>();
  for (const l of valide.workflow.liens) suivants.set(l.de, [...(suivants.get(l.de) ?? []), l.vers]);
  const atteints = new Set<string>([depart]);
  const pile = [depart];
  while (pile.length) for (const s of suivants.get(pile.pop()!) ?? []) if (!atteints.has(s)) (atteints.add(s), pile.push(s));
  const relances = valide.ordre.filter((id) => atteints.has(id));

  const amont = new Set<string>();
  for (const id of relances) for (const p of valide.predecesseurs[id] ?? []) if (!atteints.has(p)) amont.add(p);

  const sorties: Record<string, unknown> = {};
  const repris: Record<string, number | null> = {};
  const chaine = [origine, ...anterieures].slice(0, PROFONDEUR_REJEU);
  const sources = new Set<string>();
  for (const id of valide.ordre.filter((b) => amont.has(b))) {
    let trace: Execution["blocs"][number] | undefined;
    for (const e of chaine) {
      trace = e.blocs.find((b) => b.id === id);
      if (trace?.statut !== "repris" || !e.essai) {
        if (trace) sources.add(e.id);
        break;
      }
    }
    if (!trace || (trace.statut !== "reussi" && trace.statut !== "partiel")) return refus(`la sortie de « ${id} » manque dans cette exécution`);
    if (trace.sortieTronquee) return refus(`la sortie de « ${id} » a été tronquée dans cette exécution`);
    if (trace.sortie === undefined) return refus(`la sortie de « ${id} » manque dans cette exécution`);
    sorties[id] = trace.sortie;
    repris[id] = trace.elements;
  }
  return { ok: true, relances, sorties, repris, origine: sources.size === 1 ? [...sources][0]! : origine.id };
}
