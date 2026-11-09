import type { Runner } from "../../src/container/runner.js";

export type Response = { code: number; stdout?: string; stderr?: string };
export interface Call { commande: string; args: string[]; opts?: Parameters<Runner>[2] }

/** Scripted executor: the first rule whose pattern matches `commande args…` answers. */
export function fakeRunner(regles: [RegExp, Response | (() => Response | Promise<Response>)][]) {
  const calls: Call[] = [];
  const executer: Runner = async (command, args, opts) => {
    calls.push({ commande: command, args, opts });
    const ligne = [command, ...args].join(" ");
    for (const [motif, response] of regles) {
      if (!motif.test(ligne)) continue;
      const r = typeof response === "function" ? await response() : response;
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { executer, appels: calls };
}
