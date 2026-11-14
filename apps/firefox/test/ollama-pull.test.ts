import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { pullOllamaModel, UNSUPPORTED_MODEL } from "../host/ollama-pull";
import type { PullProgress } from "../shared/settings";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));
async function fake(handler: (body: any, res: import("node:http").ServerResponse) => void) {
  const requests: any[] = [];
  const s = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d)).on("end", () => {
      const body = JSON.parse(b || "{}");
      requests.push({ url: req.url, body });
      handler(body, res);
    });
  });
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, requests };
}
const events = (url: string, name: string) => {
  const got: PullProgress[] = [];
  return { got, done: pullOllamaModel(url, name, (e) => got.push(e)) };
};

describe("pullOllamaModel", () => {
  it("refuses a name outside the allowlist without any request", async () => {
    const o = await fake((_b, res) => res.end());
    await expect(pullOllamaModel(o.url, "llama3", () => {})).rejects.toThrow(UNSUPPORTED_MODEL());
    expect(o.requests).toEqual([]);
  });

  it("streams NDJSON (split mid-line) into progress events and resolves on success", async () => {
    const o = await fake((_b, res) => {
      res.write('{"status":"pulling manifest"}\n{"status":"downloading","total":100,"comp');
      setTimeout(() => res.end('leted":40}\n{"status":"success"}\n'), 20);
    });
    const { got, done } = events(o.url, "gemma4:e4b-mlx");
    await done;
    expect(o.requests[0]).toEqual({ url: "/api/pull", body: { model: "gemma4:e4b-mlx", stream: true } });
    expect(got).toEqual([
      { name: "gemma4:e4b-mlx", status: "pulling manifest", percent: null },
      { name: "gemma4:e4b-mlx", status: "downloading", percent: 40 },
      { name: "gemma4:e4b-mlx", status: "success", percent: null },
    ]);
  });

  it("passes Ollama's error through (a line, an HTTP body), and rejects a stream cut before success", async () => {
    const line = await fake((_b, res) => res.end('{"status":"pulling manifest"}\n{"error":"pull model manifest: file does not exist"}\n'));
    await expect(events(line.url, "pplx-decider-flash").done).rejects.toThrow("pull model manifest: file does not exist");
    const http = await fake((_b, res) => res.writeHead(500).end("disk full"));
    await expect(events(http.url, "pplx-decider-flash").done).rejects.toThrow("disk full");
    const cut = await fake((_b, res) => res.end('{"status":"downloading","total":10,"completed":1}\n'));
    await expect(events(cut.url, "pplx-decider-flash").done).rejects.toThrow("interrompu");
    const junk = await fake((_b, res) => res.end("<html>proxy error</html>\n"));
    await expect(events(junk.url, "pplx-decider-flash").done).rejects.toThrow("Réponse inattendue d'Ollama : <html>proxy error</html>");
  });
});
