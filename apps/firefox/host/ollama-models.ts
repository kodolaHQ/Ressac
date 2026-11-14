import { withoutV1 } from "./claude-engine.ts";
import { modelField } from "../shared/settings.ts";
import { hostSay } from "./locale.ts";

export type OllamaModels = { ok: true; models: { name: string; size?: string }[] } | { ok: false; error: string };

const down = (): OllamaModels => ({ ok: false, error: hostSay("host-ollama-down") });

/** Lists the models installed in the Ollama at `url` (read from the host, so the container alias maps to loopback). */
export async function listOllamaModels(url: string, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<OllamaModels> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: hostSay("host-invalid-address") };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: hostSay("host-invalid-address") };
  if (u.hostname === "host.docker.internal") u.hostname = "127.0.0.1";
  u.pathname = withoutV1(u.pathname.replace(/\/$/, "")) + "/api/tags";
  u.search = "";
  try {
    const res = await (o.fetch ?? fetch)(u.toString(), { redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 3000) });
    if (!res.ok) return down();
    const body = (await res.json()) as { models?: { name?: unknown; details?: { parameter_size?: unknown } }[] };
    const models = (body.models ?? [])
      .filter((m): m is { name: string; details?: { parameter_size?: unknown } } => typeof m.name === "string" && m.name !== "" && modelField.safeParse(m.name).success)
      .map((m) => (typeof m.details?.parameter_size === "string" ? { name: m.name, size: m.details.parameter_size } : { name: m.name }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { ok: true, models };
  } catch {
    return down();
  }
}
