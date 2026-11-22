// Direct load on a llama-server already running: N workers chain /v1/systemone calls; prints the calls over 1 s.
import { readFileSync } from "node:fs";
const [port, workers, limit] = process.argv.slice(2);
const corpus = JSON.parse(readFileSync(new URL("corpus.json", import.meta.url), "utf8")).slice(0, Number(limit ?? 400));
const queue = [...corpus], times = [];
const t0 = performance.now();
await Promise.all(Array.from({ length: Number(workers) }, async () => {
  for (let x = queue.shift(); x; x = queue.shift()) {
    const t = performance.now();
    const r = await fetch(`http://127.0.0.1:${port}/v1/systemone`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: JSON.stringify({ past: x.past, next: x.next }), questions: { q: { type: "noul", instructions: `The stated goal is: ${x.goal}. Does this action serve that goal?` } } }) });
    await r.text();
    times.push({ id: x.id, at: Math.round(t - t0), ms: Math.round(performance.now() - t), status: r.status });
  }
}));
const v = times.map((t) => t.ms).sort((a, b) => a - b);
console.log(`workers ${workers}: n=${v.length} p50 ${v[v.length >> 1]} p95 ${v[Math.floor(v.length * 0.95)]} max ${v.at(-1)} total ${Math.round(performance.now() - t0)} ms; over 1 s: ${JSON.stringify(times.filter((t) => t.ms > 1000))}`);
