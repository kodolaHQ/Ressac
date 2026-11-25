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
    /** For the host writer: unknown while the workshop is not started, so the CLI path decides (it wakes the machine or says it is stopped). */
    usable: async (a: WriterAgent) => (await o.workshop.state()) !== "started" || signedIn(a),
    reset: () => cache.clear(),
    signedOut: (a: WriterAgent) => void cache.delete(a),
  };
  return choice;
}

type Via = "subscription" | "api" | "ollama";
const host = (url: string) => new URL(url).hostname;

/**
 * The writer with the agents' engines (Réglages › Agent): for the preferred agent, then the other, its API key, its
 * Ollama, or its signed-in CLI (`cli`). The key goes in a header only, and is cut out of any answer quoted in an error.
 */
export function createHostWriter(o: {
  preferred(): WriterAgent;
  engine(a: WriterAgent): ClaudeEngine | CodexEngine;
  readKey(a: WriterAgent): Promise<string | null>;
  cli: Writer;
  cliUsable(a: WriterAgent): Promise<boolean>;
  fetch?: typeof fetch;
  locale(): string;
}): Writer & { via(): Promise<{ agent: WriterAgent; via: Via } | null> } {
  const t = (id: string, args?: Record<string, string>) => new Error(say(o.locale(), id, args));
  const pick = async (): Promise<{ agent: WriterAgent; via: Via; e: ClaudeEngine | CodexEngine; key?: string } | null> => {
    const first = o.preferred();
    for (const agent of [first, first === "claude" ? "codex" : "claude"] as const) {
      const e = o.engine(agent);
      if (e.kind === "api") {
        // Off Anthropic's and OpenAI's own hosts, the user's model is needed.
        const known = !apiUrlProblem(e.apiUrl) && (e.apiModel || host(e.apiUrl) === (agent === "claude" ? "api.anthropic.com" : "api.openai.com"));
        const key = known ? await o.readKey(agent) : null;
        if (key) return { agent, via: "api", e, key };
      } else if (e.kind === "ollama") {
        if (e.ollamaUrl && e.ollamaModel) return { agent, via: "ollama", e };
      } else if (await o.cliUsable(agent)) return { agent, via: "subscription", e };
    }
    return null;
  };

  const call = async (p: { agent: WriterAgent; via: Via; e: ClaudeEngine | CodexEngine; key?: string }, prompt: string, json: boolean, caller?: AbortSignal): Promise<unknown> => {
    const { agent, via, e, key = "" } = p;
    const system = writerSystemPrompt(json);
    const trim = (u: string) => u.replace(/\/$/, "");
    const [url, headers, body] =
      via === "ollama"
        ? [`${trim(withoutV1(macSideUrl(e.ollamaUrl)))}/api/chat`, {}, { model: e.ollamaModel, stream: false, keep_alive: "1m", messages: [{ role: "system", content: system }, { role: "user", content: prompt }], ...(json ? { format: "json" } : {}) }]
        : agent === "claude"
          ? [`${trim(withoutV1(e.apiUrl))}/v1/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, { model: host(e.apiUrl) === "api.anthropic.com" ? "claude-haiku-4-5" : e.apiModel, max_tokens: 4096, system, messages: [{ role: "user", content: prompt }] }]
          : [`${trim(e.apiUrl)}/responses`, { authorization: `Bearer ${key}` }, { model: host(e.apiUrl) === "api.openai.com" ? CODEX_WRITER_MODEL : e.apiModel, instructions: system, input: prompt }];
    const signal = AbortSignal.any([...(caller ? [caller] : []), AbortSignal.timeout(WRITER_TIMEOUT_MS)]);
    // Only the status and a key-free tail of the answer are quoted.
    const failed = (reason: string) => t("kernel-writer-failed", { reason: (key ? reason.split(key).join("…") : reason).trim().slice(-300) });
    let res: Response;
    try {
      res = await (o.fetch ?? fetch)(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
    } catch (err) {
      if (caller?.aborted) throw caller.reason ?? err;
      throw failed(err instanceof Error ? err.message : String(err));
    }
    if (res.status === 401 || res.status === 403) throw failed(say(o.locale(), "kernel-writer-key-refused"));
    if (res.status === 429) throw t("kernel-writer-limit");
    if (!res.ok) throw failed(`HTTP ${res.status} ${await res.text().catch(() => "")}`);
    const out = (await res.json().catch(() => ({}))) as {
      content?: { text?: string }[];
      output_text?: string;
      output?: { content?: { text?: string }[] }[];
      message?: { content?: string };
    };
    const texts = (xs?: { text?: string }[]) => (xs ?? []).map((x) => x.text ?? "").join("");
    const text = (via === "ollama" ? (out.message?.content ?? "") : agent === "claude" ? texts(out.content) : (out.output_text ?? (out.output ?? []).map((x) => texts(x.content)).join(""))).trim();
    return json ? parseWriterJson(text) : text;
  };

  const writer = async (r: Parameters<Writer>[0]) => {
    if (r.images?.length) throw t("kernel-writer-images");
    const p = await pick();
    if (!p) throw t("kernel-writer-none");
    return p.via === "subscription" ? o.cli(r) : call(p, r.prompt, !!r.json, r.signal);
  };
  return Object.assign(writer, { via: async () => { const p = await pick(); return p && { agent: p.agent, via: p.via }; } });
}
