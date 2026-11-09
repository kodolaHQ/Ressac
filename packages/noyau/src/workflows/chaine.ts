import { REGISTRE_BLOCS } from "./blocs/index.js";
import type { WorkflowValide } from "./valider.js";

// The same rule is copied into the container's interpreter (docker/moteur): a test checks that they agree.

/**
 * The "as-it-goes" chain: the blocks each item goes through alone up to the output, in run
 * order. Empty if the output does not publish as it goes or does not have exactly one predecessor.
 *
 * Going up from the output's predecessor, a block is taken as long as it is chainable (`chaine` and
 * `parElement` true) and has only one successor (the block taken just before, or the output); we go up through its only
 * predecessor, and stop after it if it has several. Finally, blocks are removed at the start as long as the rest
 * is not a contiguous slice of the run order. A try has no chain: it is up to the caller to judge.
 */
export function chaineAuFilDeLEau(v: WorkflowValide): string[] {
  const blocs = new Map(v.workflow.blocs.map((b) => [b.id, b]));
  if (blocs.get(v.sortie.id)?.parametres.auFilDeLEau !== true) return [];
  const amont = v.predecesseurs[v.sortie.id]!;
  if (amont.length !== 1) return [];

  const successeurs = new Map<string, string[]>();
  for (const [id, preds] of Object.entries(v.predecesseurs)) {
    for (const p of preds) successeurs.set(p, [...(successeurs.get(p) ?? []), id]);
  }

  const chaine: string[] = [];
  let suivant = v.sortie.id;
  let courant: string | undefined = amont[0];
  while (courant !== undefined) {
    const b = blocs.get(courant)!;
    if (REGISTRE_BLOCS.get(b.type)?.chaine !== true || b.parametres.parElement !== true) break;
    const apres = successeurs.get(courant) ?? [];
    if (apres.length !== 1 || apres[0] !== suivant) break;
    chaine.unshift(courant);
    const avant: string[] = v.predecesseurs[courant]!;
    if (avant.length !== 1) break;
    suivant = courant;
    courant = avant[0];
  }

  while (chaine.length > 0) {
    const debut = v.ordre.indexOf(chaine[0]!);
    if (chaine.every((id, i) => v.ordre[debut + i] === id)) break;
    chaine.shift();
  }
  return chaine;
}
