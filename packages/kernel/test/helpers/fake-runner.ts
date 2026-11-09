import type { Runner } from "../../src/container/runner.js";

export type Response = { code: number; stdout?: string; stderr?: string };
export interface Call { commande: string; args: string[]; opts?: Parameters<Runner>[2] }

/** Scripted executor: the first rule whose pattern matches `commande args…` answers. */
export function fakeRunner(rules: [RegExp, Response | (() => Response | Promise<Response>)][]) {
  const calls: Call[] = [];
  const run: Runner = async (command, args, opts) => {
    calls.push({ commande: command, args, opts });
    const line = [command, ...args].join(" ");
    for (const [pattern, response] of rules) {
      if (!pattern.test(line)) continue;
      const r = typeof response === "function" ? await response() : response;
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { executer: run, appels: calls };
}
