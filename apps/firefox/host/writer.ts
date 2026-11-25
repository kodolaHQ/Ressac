import { CODEX_WRITER_MODEL, WRITER_TIMEOUT_MS, parseWriterJson, say, writerSystemPrompt, type Workshop, type WriterAgent } from "../../../packages/kernel/src/index.ts";
import type { Writer } from "../../../packages/kernel/src/ai/writer.ts";
import { apiUrlProblem, type ClaudeEngine, type CodexEngine } from "../shared/settings.ts";
import { withoutV1 } from "./claude-engine.ts";
import { macSideUrl } from "./ollama-models.ts";
import { AGENT_ACCOUNTS, startedWithin } from "./settings.ts";

const TTL_MS = 5 * 60_000;

/**
 * Which agent writes: the preferred one if signed in, else the other, else none; "workshop-stopped" when its accounts
 * cannot be read. `agent` never starts the workshop; `wakeAgent`, for a write, starts it when Ressac's machine is stopped (unless removed or failing).
 */
export function createWriterChoice(o: { workshop: Pick<Workshop, "state" | "exec" | "ensureStarted" | "harvestReady">; preferred(): WriterAgent; now?(): number }) {
  const now = o.now ?? Date.now;
  // The in-flight promise is cached, so parallel cold calls share one status exec; a failed check is not kept.
  const cache = new Map<WriterAgent, { at: number; in: Promise<boolean> }>();
  const signedIn = (a: WriterAgent): Promise<boolean> => {
    const hit = cache.get(a);
    if (hit && now() - hit.at < TTL_MS) return hit.in;
    const account = AGENT_ACCOUNTS.find((x) => x.id === a)!;
    const entry = { at: now(), in: o.workshop.exec(account.status).then((r) => account.parse(r).loggedIn) };
    cache.set(a, entry);
    const forget = () => void (cache.get(a) === entry && cache.delete(a));
    entry.in = entry.in.catch(() => (forget(), false));
    return entry.in;
  };
  const choice = {
    /** `exclude`: agents whose call answered "not signed in" while their status still says signed in (a dead token). */
    async agent(exclude?: ReadonlySet<WriterAgent>): Promise<WriterAgent | "workshop-stopped" | null> {
      if ((await o.workshop.state()) !== "started") return "workshop-stopped";
      const first = o.preferred();
      for (const a of [first, first === "claude" ? "codex" : "claude"] as const) if (!exclude?.has(a) && (await signedIn(a))) return a;
      return null;
    },
    async wakeAgent(exclude?: ReadonlySet<WriterAgent>): Promise<WriterAgent | "workshop-stopped" | null> {
      // A machine the user removed, or one failing, waits for them: a background write (a watch) never installs or boots it.
      if ((await o.workshop.state()) === "machine-stopped" && (await o.workshop.harvestReady())) await startedWithin(o.workshop.ensureStarted(), null); // still stopped: agent says so
      return choice.agent(exclude);
    },
    /** For the host writer, without starting anything: signed in, unknown but the machine can wake for a write, or why not. */
    async usable(a: WriterAgent): Promise<CliState> {
      const s = await o.workshop.state();
      if (s === "started") return (await signedIn(a)) ? "signed-in" : "signed-out";
      return s === "machine-stopped" && (await o.workshop.harvestReady()) ? "wakeable" : "stopped";
    },
    reset: () => cache.clear(),
    signedOut: (a: WriterAgent) => void cache.delete(a),
  };
  return choice;
}

/** A CLI's state for the writer: `wakeable` = sign-in unknown, the machine can start for a write; `stopped` = it cannot. */
export type CliState = "signed-in" | "signed-out" | "wakeable" | "stopped";
type Via = "subscription" | "api" | "ollama";
type Path = { agent: WriterAgent; via: Via; e: ClaudeEngine | CodexEngine; key?: string };
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/**
 * The writer with the agents' engines (Réglages › Agent): first a path known to work on either agent (its API key,
 * its Ollama, its signed-in CLI), the preferred agent first; then a CLI whose machine can wake. The key goes in a
 * header only, and is cut out of any answer quoted in an error.
 */
export function createHostWriter(o: {
  preferred(): WriterAgent;
  engine(a: WriterAgent): ClaudeEngine | CodexEngine;
  readKey(a: WriterAgent): Promise<string | null>;
  /** The subscription CLI writing as this agent only. */
  cli(a: WriterAgent): Writer;
  cliUsable(a: WriterAgent): Promise<CliState>;
  fetch?: typeof fetch;
  locale(): string;
}): Writer & { via(): Promise<{ agent: WriterAgent; via: Via } | "workshop-stopped" | null> } {
  const t = (id: string, args?: Record<string, string>) => new Error(say(o.locale(), id, args));
  const pick = async (): Promise<Path | "workshop-stopped" | null> => {
    const first = o.preferred();
    const agents = [first, first === "claude" ? "codex" : "claude"] as const;
    const clis = new Map<WriterAgent, CliState>();
    for (const agent of agents) {
      const e = o.engine(agent);
      if (e.kind === "api") {
        // Off Anthropic's and OpenAI's own hosts, the user's model is needed.
        const known = !apiUrlProblem(e.apiUrl) && (e.apiModel || hostOf(e.apiUrl) === (agent === "claude" ? "api.anthropic.com" : "api.openai.com"));
        const key = known ? await o.readKey(agent) : null;
        if (key) return { agent, via: "api", e, key };
      } else if (e.kind === "ollama") {
        if (hostOf(e.ollamaUrl) && e.ollamaModel) return { agent, via: "ollama", e };
      } else {
        const s = await o.cliUsable(agent);
        if (s === "signed-in") return { agent, via: "subscription", e };
        clis.set(agent, s);
      }
    }
    for (const agent of agents) if (clis.get(agent) === "wakeable") return { agent, via: "subscription", e: o.engine(agent) };
    return [...clis.values()].includes("stopped") ? "workshop-stopped" : null;
  };

  const call = async (p: Path, prompt: string, json: boolean, caller?: AbortSignal): Promise<unknown> => {
    const { agent, via, e, key = "" } = p;
    const system = writerSystemPrompt(json);
    const trim = (u: string) => u.replace(/\/$/, "");
    const [url, headers, body] =
      via === "ollama"
        ? [`${trim(withoutV1(macSideUrl(e.ollamaUrl)))}/api/chat`, {}, { model: e.ollamaModel, stream: false, keep_alive: "1m", messages: [{ role: "system", content: system }, { role: "user", content: prompt }], ...(json ? { format: "json" } : {}) }]
        : agent === "claude"
          ? [`${trim(withoutV1(e.apiUrl))}/v1/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, { model: hostOf(e.apiUrl) === "api.anthropic.com" ? "claude-haiku-4-5" : e.apiModel, max_tokens: 4096, system, messages: [{ role: "user", content: prompt }] }]
          : [`${trim(e.apiUrl)}/responses`, { authorization: `Bearer ${key}` }, { model: hostOf(e.apiUrl) === "api.openai.com" ? CODEX_WRITER_MODEL : e.apiModel, instructions: system, input: prompt }];
    const signal = AbortSignal.any([...(caller ? [caller] : []), AbortSignal.timeout(WRITER_TIMEOUT_MS)]);
    // Only the status and a key-free tail of the answer are quoted.
    const failed = (reason: string) => t("kernel-writer-failed", { reason: (key ? reason.split(key).join("…") : reason).trim().slice(-300) });
    let status = 0;
    let raw = "";
    let out: { content?: { text?: string }[]; output_text?: string; output?: { content?: { text?: string }[] }[]; message?: { content?: string } } = {};
    try {
      const res = await (o.fetch ?? fetch)(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
      status = res.status;
      if (res.ok) out = await res.json();
      else raw = await res.text();
    } catch (err) {
      // A caller's stop stays a stop; a timeout, a network error or an unreadable body reads as a failure.
      if (caller?.aborted) throw caller.reason ?? err;
      throw failed(err instanceof Error ? err.message : String(err));
    }
    if (status === 401 || status === 403) throw failed(say(o.locale(), "kernel-writer-key-refused"));
    if (status === 429) throw t("kernel-writer-limit-api");
    if (status < 200 || status >= 300) throw failed(`HTTP ${status} ${raw}`);
    const texts = (xs?: { text?: string }[]) => (xs ?? []).map((x) => x.text ?? "").join("");
    const text = (via === "ollama" ? (out.message?.content ?? "") : agent === "claude" ? texts(out.content) : (out.output_text ?? (out.output ?? []).map((x) => texts(x.content)).join(""))).trim();
    return json ? parseWriterJson(text) : text;
  };

  const writer = async (r: Parameters<Writer>[0]) => {
    if (r.images?.length) throw t("kernel-writer-images");
    const p = await pick();
    if (p === "workshop-stopped") throw t("kernel-writer-workshop-stopped");
    if (!p) throw t("kernel-writer-none");
    return p.via === "subscription" ? o.cli(p.agent)(r) : call(p, r.prompt, !!r.json, r.signal);
  };
  return Object.assign(writer, {
    via: async () => {
      const p = await pick();
      return p && typeof p === "object" ? { agent: p.agent, via: p.via } : p;
    },
  });
}
