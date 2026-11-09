// Workflow engine harness: launches recolteur.mjs in a Node process and answers its calls.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempFolder } from "./temp.js";
import { DEFAULT_CONTEXT, validateWorkflow, type ValidationContext } from "../../src/workflows/validate.js";
import type { BlocksMemory } from "../../src/workflows/memory.js";

export const ENGINE = join(import.meta.dirname, "..", "..", "docker", "moteur");
export const SCRIPT = join(ENGINE, "recolteur.mjs");

export type Call = { t: "appel"; n: number; f: string; a: any };
export type Responder = (call: Call) => Promise<{ ok: unknown } | { erreur: string }> | { ok: unknown } | { erreur: string };

/**
 * The workflow as the kernel sends it: validated (with what the widget declares, the earlier rules without it),
 * default parameters filled in, with the order.
 */
export function sentWorkflow(brut: unknown, context: ValidationContext = DEFAULT_CONTEXT) {
  const r = validateWorkflow(brut, context);
  if (!r.ok) throw new Error(r.erreur);
  return { blocs: r.valide.workflow.blocs, liens: r.valide.workflow.liens, ordre: r.valide.ordre };
}

export async function lancer(o: {
  workflow: unknown;
  fichiers?: Record<string, string>;
  memoire?: BlocksMemory;
  config?: unknown;
  precedent?: unknown;
  repondre?: Responder;
  rejeu?: { relances: string[]; sorties: Record<string, unknown> };
  /** What the widget declares (`web`, `dureeMaxMinutes`): the validation of the workflow sent. */
  contexte?: ValidationContext;
  /** Keys added to the `debut` line (absent otherwise, like for a widget today). */
  debut?: { progressif?: true; limiteMs?: number; saisie?: string; avancement?: true };
}) {
  const dossier = await tempFolder();
  await writeFile(join(dossier, "widget.json"), JSON.stringify({ config: { lu: "dans widget.json" } }));
  for (const [name, content] of Object.entries(o.fichiers ?? {})) await writeFile(join(dossier, name), content);
  const child = spawn("node", [SCRIPT, dossier], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const lignes: any[] = [];
  const calls: Call[] = [];
  let tampon = "";
  const finished = new Promise<number | null>((ok) => child.on("close", (code) => ok(code)));
  child.stdout.on("data", (d) => {
    tampon += d;
    let i;
    while ((i = tampon.indexOf("\n")) >= 0) {
      const ligne = tampon.slice(0, i);
      tampon = tampon.slice(i + 1);
      const m = JSON.parse(ligne);
      lignes.push(m);
      if (m.t === "appel") {
        calls.push(m);
        const reply = o.repondre ?? (() => ({ ok: null }));
        void Promise.resolve(reply(m)).then((r) => child.stdin.write(JSON.stringify({ t: "reponse", n: m.n, ...r }) + "\n"));
      }
    }
  });
  child.stdin.write(
    JSON.stringify({
      t: "debut",
      precedent: o.precedent ?? null,
      maintenant: "2026-10-29T10:00:00.000Z",
      config: o.config ?? null,
      workflow: sentWorkflow(o.workflow, o.contexte),
      ...(o.rejeu ? { rejeu: o.rejeu } : {}),
      ...o.debut,
    }) + "\n",
  );
  child.stdin.write(JSON.stringify({ t: "memoire", memoire: o.memoire ?? {} }) + "\n");
  const code = await finished;
  return {
    code,
    lignes,
    appels: calls,
    stderr,
    traces: lignes.filter((l) => l.t !== "appel"),
    terminal: lignes.find((l) => l.t === "fin" || l.t === "echec"),
    finBloc: (id: string) => lignes.find((l) => l.t === "bloc" && l.id === id && l.etape === "fin"),
  };
}

export const bloc = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, parametres: params });
export const chain = (...ids: string[]) => ids.slice(1).map((to, i) => ({ de: ids[i]!, vers: to }));
export const sortie = bloc("sortie", "sortie", { vers: "widget" });
