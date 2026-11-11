import type { PullProgress } from "../shared/settings.ts";

export const PULLABLE_MODELS = ["gemma4:e4b-mlx", "pplx-decider-flash"];
export const UNSUPPORTED_MODEL = "Modèle non pris en charge";

/**
 * Pulls `name` through Ollama's API (`POST /api/pull`, NDJSON), reporting each line. Resolves when the last line is
 * `success`; rejects with Ollama's own message otherwise. No cancel: Ollama keeps the downloaded chunks and resumes later.
 */
export async function pullOllamaModel(url: string, name: string, onProgress: (p: PullProgress) => void, f: typeof fetch = fetch): Promise<void> {
  if (!PULLABLE_MODELS.includes(name)) throw new Error(UNSUPPORTED_MODEL);
  const res = await f(`${url.replace(/\/$/, "")}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name, stream: true }) });
  if (!res.ok || !res.body) throw new Error((await res.text().catch(() => "")).trim() || `Ollama a répondu ${res.status}`);
  let done = false;
  const line = (l: string) => {
    if (!l.trim()) return;
    let j: { status?: string; error?: string; total?: number; completed?: number };
    try {
      j = JSON.parse(l);
    } catch {
      throw new Error(`Réponse inattendue d'Ollama : ${l.slice(0, 120)}`);
    }
    if (j.error) throw new Error(j.error);
    const status = j.status ?? "";
    if (status === "success") done = true;
    onProgress({ name, status, percent: j.total ? Math.min(100, Math.round(((j.completed ?? 0) / j.total) * 100)) : null });
  };
  let rest = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    lines.forEach(line);
  }
  line(rest);
  if (!done) throw new Error("Le téléchargement s'est interrompu");
}
