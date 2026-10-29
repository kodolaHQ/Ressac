import { REGISTRE_BLOCS } from "./blocs/index.js";
import type { WorkflowValide } from "./valider.js";

// La même règle est recopiée dans l'interpréteur du conteneur (docker/moteur) : un test vérifie qu'elles s'accordent.

/**
 * La chaîne « au fil de l'eau » : les blocs que chaque élément traverse seul jusqu'à la sortie, dans l'ordre
 * d'exécution. Vide si la sortie ne publie pas au fil de l'eau ou n'a pas exactement un prédécesseur.
 *
 * En remontant depuis le prédécesseur de la sortie, on prend un bloc tant qu'il est chaînable (`chaine` et
 * `parElement` vrai) et qu'il n'a qu'un successeur (le bloc pris juste avant, ou la sortie) ; on remonte par son unique
 * prédécesseur, et on s'arrête après lui s'il en a plusieurs. Enfin, on retire des blocs au début tant que la suite
 * n'est pas une tranche contiguë de l'ordre d'exécution. Un essai n'a pas de chaîne : c'est à l'appelant d'en juger.
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
