import type { z } from "zod";
import { REGISTRE_BLOCS } from "./blocs/index.js";
import { PREFIXE_WORKFLOW_INVALIDE, Workflow, type GenreSortie } from "./schema.js";

export type WorkflowValide = {
  /** Le workflow, paramètres remplis des valeurs par défaut. */
  workflow: Workflow;
  /** Ordre d'exécution : tri topologique, à égalité dans l'ordre du tableau `blocs`. */
  ordre: string[];
  predecesseurs: Record<string, string[]>;
  sortie: { id: string; vers: GenreSortie };
};

export type ResultatValidation = { ok: true; valide: WorkflowValide } | { ok: false; erreur: string };

const LONGUEUR_MAX_ERREUR = 300;

/** Une erreur de validation, préfixée et bornée. */
export function erreurWorkflow(cause: string): { ok: false; erreur: string } {
  const texte = PREFIXE_WORKFLOW_INVALIDE + cause;
  return { ok: false, erreur: texte.length > LONGUEUR_MAX_ERREUR ? texte.slice(0, LONGUEUR_MAX_ERREUR - 1) + "…" : texte };
}

/** Premier problème zod, sous la forme « <chemin> : <message> ». */
function premierProbleme(erreur: z.ZodError, racine?: string): string {
  const p = erreur.issues[0]!;
  const chemin = [...p.path.map(String)];
  if (p.code === "unrecognized_keys") chemin.push(...p.keys.slice(0, 1));
  const message = p.code === "unrecognized_keys" ? "paramètre inconnu" : p.message;
  const nom = [...(racine ? [racine] : []), ...chemin].join(".");
  return nom ? `${nom} : ${message}` : message;
}

/** Un cycle parmi les blocs restants, nommé « a → b → a », en partant du premier dans l'ordre du tableau. */
function nommerCycle(restants: string[], predecesseurs: Record<string, string[]>): string {
  const reste = new Set(restants);
  const vus: string[] = [];
  let courant = restants[0]!;
  while (!vus.includes(courant)) {
    vus.push(courant);
    courant = predecesseurs[courant]!.find((p) => reste.has(p))!;
  }
  // En remontant les prédécesseurs, on a le cycle à l'envers.
  const cycle = vus.slice(vus.indexOf(courant)).reverse();
  const depart = cycle.reduce((m, id, i) => (restants.indexOf(id) < restants.indexOf(cycle[m]!) ? i : m), 0);
  const tourne = [...cycle.slice(depart), ...cycle.slice(0, depart)];
  return [...tourne, tourne[0]!].join(" → ");
}

export function validerWorkflow(brut: unknown): ResultatValidation {
  const lu = Workflow.safeParse(brut);
  if (!lu.success) return erreurWorkflow(premierProbleme(lu.error));
  const workflow = lu.data;

  const ids = new Set<string>();
  for (const b of workflow.blocs) {
    if (ids.has(b.id)) return erreurWorkflow(`id de bloc en double : ${b.id}`);
    ids.add(b.id);
  }

  for (const b of workflow.blocs) {
    const definition = REGISTRE_BLOCS.get(b.type);
    if (!definition) return erreurWorkflow(`type inconnu : ${b.type}`);
    if (definition.parElement === "non" && "parElement" in b.parametres) {
      return erreurWorkflow(`${b.id}.parElement : le type ${b.type} ne travaille pas élément par élément`);
    }
    const parametres = definition.parametres.safeParse(b.parametres);
    if (!parametres.success) return erreurWorkflow(premierProbleme(parametres.error, b.id));
    b.parametres = parametres.data as Record<string, unknown>;
  }

  const predecesseurs: Record<string, string[]> = Object.fromEntries(workflow.blocs.map((b) => [b.id, []]));
  for (const l of workflow.liens) {
    for (const bout of [l.de, l.vers]) {
      if (!ids.has(bout)) return erreurWorkflow(`lien vers un bloc absent : ${bout}`);
    }
    if (!predecesseurs[l.vers]!.includes(l.de)) predecesseurs[l.vers]!.push(l.de);
  }

  const sorties = workflow.blocs.filter((b) => b.type === "sortie");
  if (sorties.length === 0) return erreurWorkflow("aucune sortie");
  if (sorties.length > 1) return erreurWorkflow(`plusieurs sorties : ${sorties.map((b) => b.id).join(", ")}`);

  // Tri de Kahn : à chaque tour, le premier bloc (dans l'ordre du tableau) dont tous les prédécesseurs sont placés.
  const ordre: string[] = [];
  const places = new Set<string>();
  let restants = workflow.blocs.map((b) => b.id);
  while (restants.length > 0) {
    const prochain = restants.find((id) => predecesseurs[id]!.every((p) => places.has(p)));
    if (prochain === undefined) return erreurWorkflow(`cycle : ${nommerCycle(restants, predecesseurs)}`);
    ordre.push(prochain);
    places.add(prochain);
    restants = restants.filter((id) => id !== prochain);
  }

  const vers = (sorties[0]!.parametres as { vers: GenreSortie }).vers;
  return { ok: true, valide: { workflow, ordre, predecesseurs, sortie: { id: sorties[0]!.id, vers } } };
}

/** Le workflow d'un widget qui n'a que `recolte.mjs` : récolte → sortie. */
export function workflowImplicite(): Workflow {
  return {
    version: 1,
    blocs: [
      { id: "recolte", type: "code", position: { x: 0, y: 0 }, parametres: { source: "recolte.mjs", appel: "recolte" } },
      { id: "sortie", type: "sortie", position: { x: 0, y: 0 }, parametres: { vers: "widget" } },
    ],
    liens: [{ de: "recolte", vers: "sortie" }],
  };
}
