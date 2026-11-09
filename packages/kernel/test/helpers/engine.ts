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
export type Responder = (call: Call) => Promise<{ ok: unknown } | { error: string }> | { ok: unknown } | { error: string };

/**
 * The workflow as the kernel sends it: validated (with what the widget declares, the earlier rules without it),
 * default parameters filled in, with the order.
 */
export function sentWorkflow(raw: unknown, context: ValidationContext = DEFAULT_CONTEXT) {
  const r = validateWorkflow(raw, context);
  if (!r.ok) throw new Error(r.error);
  return { blocks: r.valid.workflow.blocks, links: r.valid.workflow.links, order: r.valid.order };
}

export async function launch(o: {
  workflow: unknown;
  files?: Record<string, string>;
  memory?: BlocksMemory;
  config?: unknown;
  previous?: unknown;
  reply?: Responder;
  replay?: { reruns: string[]; outputs: Record<string, unknown> };
  /** What the widget declares (`web`, `dureeMaxMinutes`): the validation of the workflow sent. */
  context?: ValidationContext;
  /** Keys added to the `debut` line (absent otherwise, like for a widget today). */
  start?: { progressive?: true; limitMs?: number; input?: string; progress?: true };
}) {
  const folder = await tempFolder();
  await writeFile(join(folder, "widget.json"), JSON.stringify({ config: { read: "dans widget.json" } }));
  for (const [name, content] of Object.entries(o.files ?? {})) await writeFile(join(folder, name), content);
  const child = spawn("node", [SCRIPT, folder], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const lines: any[] = [];
  const calls: Call[] = [];
  let buffer = "";
  const finished = new Promise<number | null>((ok) => child.on("close", (code) => ok(code)));
  child.stdout.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const m = JSON.parse(line);
      lines.push(m);
      if (m.t === "appel") {
        calls.push(m);
        const reply = o.reply ?? (() => ({ ok: null }));
        void Promise.resolve(reply(m)).then((r) => child.stdin.write(JSON.stringify({ t: "reponse", n: m.n, ...r }) + "\n"));
      }
    }
  });
  child.stdin.write(
    JSON.stringify({
      t: "debut",
      previous: o.previous ?? null,
      now: "2026-10-29T10:00:00.000Z",
      config: o.config ?? null,
      workflow: sentWorkflow(o.workflow, o.context),
      ...(o.replay ? { replay: o.replay } : {}),
      ...o.start,
    }) + "\n",
  );
  child.stdin.write(JSON.stringify({ t: "memoire", memory: o.memory ?? {} }) + "\n");
  const code = await finished;
  return {
    code,
    lines,
    calls: calls,
    stderr,
    traces: lines.filter((l) => l.t !== "appel"),
    terminal: lines.find((l) => l.t === "fin" || l.t === "echec"),
    blockEnd: (id: string) => lines.find((l) => l.t === "bloc" && l.id === id && l.etape === "fin"),
  };
}

export const block = (id: string, type: string, params: Record<string, unknown> = {}) => ({ id, type, params: params });
export const chain = (...ids: string[]) => ids.slice(1).map((to, i) => ({ from: ids[i]!, to: to }));
export const output = block("sortie", "sortie", { to: "widget" });
