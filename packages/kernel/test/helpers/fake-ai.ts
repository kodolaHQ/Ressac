import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface SavedRequest { method: string; url: string; body: any }
export interface FakeServer { url: string; requests: SavedRequest[]; close(): Promise<void> }

async function start(reply: (req: SavedRequest, res: import("node:http").ServerResponse) => void): Promise<FakeServer> {
  const requests: SavedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (m) => chunks.push(m));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const r = { method: req.method ?? "", url: req.url ?? "", body: text ? JSON.parse(text) : undefined };
      requests.push(r);
      reply(r, res);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: requests,
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

const json = (res: import("node:http").ServerResponse, code: number, o: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(o));
};

/** Fake Kev: /v1/models and /v1/systemone. */
export const fakeKev = (answers: unknown = { q: { type: "noul", noul: 0.91 } }) =>
  start((r, res) => {
    if (r.url === "/v1/models") return json(res, 200, { data: [{ id: "d1-2B-Q4_K_M.gguf" }] });
    if (r.url === "/v1/systemone") return json(res, 200, { model: "kev-latest", answers, usage: {} });
    json(res, 404, {});
  });

/** A server that is not llama-server: answers 200 to everything, without naming a model. */
export const fakeForeign = () => start((_r, res) => json(res, 200, { data: [] }));

/** Fake Ollama: /api/chat answers `contenu`. */
export const fakeOllama = (content: string, models: string[] = ["gemma4:e4b-mlx"]) =>
  start((r, res) => {
    if (r.url === "/api/chat") return json(res, 200, { message: { content } });
    if (r.url === "/api/tags") return json(res, 200, { models: models.map((name) => ({ name })) });
    json(res, 404, {});
  });

/** Port on which nothing listens. */
export async function unreachableUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return `http://127.0.0.1:${port}`;
}

/** Fake Ollama that never answers /api/chat; `coupees` counts the requests abandoned by the client. */
export async function fakeSilentOllama(): Promise<FakeServer & { cut: () => number }> {
  let cuts = 0;
  const s = await start((_r, res) => {
    res.on("close", () => {
      if (!res.writableEnded) cuts++;
    });
  });
  return { ...s, cut: () => cuts };
}
