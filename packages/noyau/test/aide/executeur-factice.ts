import type { Executeur } from "../../src/conteneur/executeur.js";

export type Reponse = { code: number; stdout?: string; stderr?: string };
export interface Appel { commande: string; args: string[]; opts?: Parameters<Executeur>[2] }

/** Scripted executor: the first rule whose pattern matches `commande args…` answers. */
export function executeurFactice(regles: [RegExp, Reponse | (() => Reponse | Promise<Reponse>)][]) {
  const appels: Appel[] = [];
  const executer: Executeur = async (commande, args, opts) => {
    appels.push({ commande, args, opts });
    const ligne = [commande, ...args].join(" ");
    for (const [motif, reponse] of regles) {
      if (!motif.test(ligne)) continue;
      const r = typeof reponse === "function" ? await reponse() : reponse;
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { executer, appels };
}
