import { withoutV1, withV1 } from "./claude-engine.ts";
import { modelField } from "../shared/settings.ts";
import { hostSay } from "./locale.ts";

/** `cloud`: an Ollama cloud model (pulled as `…-cloud`, `remote_host` set): its prompts go to ollama.com, not this Mac. */
export type OllamaModels = { ok: true; models: { name: string; size?: string; cloud?: true }[] } | { ok: false; error: string };

const down = (): OllamaModels => ({ ok: false, error: hostSay("host-ollama-down") });

/** The Mac cannot resolve the container alias: it reaches the same Ollama on loopback. */
export const macSideUrl = (url: string): string => {
  const u = new URL(url);
  if (u.hostname === "host.docker.internal") u.hostname = "127.0.0.1";
  return u.href;
};

/** Where the relay (on the Mac) forwards an Ollama session: Claude Code appends /v1/messages, Codex appends /responses. */
export const ollamaRelayTarget = (url: string, profile: "claude" | "codex"): string => (profile === "claude" ? withoutV1(macSideUrl(url)).replace(/\/$/, "") : withV1(macSideUrl(url)));

/** Lists the models installed in the Ollama at `url` (read from the host, so the container alias maps to loopback). */
export async function listOllamaModels(url: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<OllamaModels> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: hostSay("host-invalid-address") };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: hostSay("host-invalid-address") };
  u.hostname = new URL(macSideUrl(url)).hostname;
  u.pathname = withoutV1(u.pathname.replace(/\/$/, "")) + "/api/tags";
  u.search = "";
  try {
    const res = await (o.fetch ?? fetch)(u.toString(), { redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 3000) });
    if (!res.ok) return down();
    type Listed = { name: string; remote_host?: unknown; details?: { parameter_size?: unknown } };
    const body = (await res.json()) as { models?: Partial<Listed>[] };
    const models = (body.models ?? [])
      .filter((m): m is Listed => typeof m.name === "string" && m.name !== "" && modelField.safeParse(m.name).success)
      .map((m) => ({
        name: m.name,
        ...(typeof m.details?.parameter_size === "string" && m.details.parameter_size ? { size: m.details.parameter_size } : {}),
        ...(typeof m.remote_host === "string" && m.remote_host ? { cloud: true as const } : {}),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { ok: true, models };
  } catch {
    return down();
  }
}
