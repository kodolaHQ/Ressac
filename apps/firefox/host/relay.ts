import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline, Readable } from "node:stream";
import { NO_KEY } from "./codex-engine";

/** Codex only calls POST /responses (seen with the real CLI, plan 45 task 1). */
export const RELAY_PATHS = ["/responses"];
const DROPPED = new Set(["authorization", "host", "connection", "content-length", "cookie", "proxy-authorization", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer"]);

export interface Relay {
  port: number;
  containerUrl: string;
  openSession(): string;
  closeSession(token: string): void;
  stop(): Promise<void>;
}

const sameToken = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
};
const reply = (res: http.ServerResponse, status: number, message: string) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));

/**
 * A local HTTP relay to the compatible API: the container sends a session token, the relay swaps it for the real key.
 * The key stays on the Mac: never in a log, never in a header sent back, masked in error bodies.
 */
export async function startRelay(o: { target(): string | null; readKey(): Promise<string | null>; host?: string; port?: number }): Promise<Relay> {
  const tokens = new Set<string>();
  const server = http.createServer(async (req, res) => {
    const [pathname = "", ...q] = (req.url ?? "").split("?");
    const query = q.length ? "?" + q.join("?") : "";
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    let status = 500;
    try {
      const ok = [...tokens].reduce((found, t) => sameToken(t, bearer) || found, false);
      if (!ok) status = 401, reply(res, 401, "Jeton invalide");
      else if (!RELAY_PATHS.includes(pathname)) status = 404, reply(res, 404, "Introuvable");
      else if (req.method !== "POST") status = 405, reply(res, 405, "Méthode non permise");
      else {
        const target = o.target();
        const key = target ? await o.readKey() : null;
        if (!target) status = 503, reply(res, 503, "Aucune API compatible n'est réglée dans WebAiOs (Réglages › Agents).");
        else if (!key) status = 503, reply(res, 503, NO_KEY);
        else {
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROPPED.has(k)) headers.set(k, [v].flat().join(", "));
          headers.set("authorization", `Bearer ${key}`);
          // The container left: stop the upstream call (billed tokens) while waiting for headers and while streaming.
          const ac = new AbortController();
          res.on("close", () => ac.abort());
          const up = await fetch(target.replace(/\/$/, "") + pathname + query, {
            method: req.method,
            headers,
            body: Readable.toWeb(req) as ReadableStream,
            duplex: "half",
            redirect: "manual",
            signal: ac.signal,
          } as RequestInit).catch(() => null);
          if (!up || (up.status >= 300 && up.status < 400)) status = 502, reply(res, 502, "API compatible injoignable");
          else if (up.status < 300) {
            status = up.status;
            res.writeHead(up.status, up.headers.get("content-type") ? { "content-type": up.headers.get("content-type")! } : {});
            if (up.body) pipeline(Readable.fromWeb(up.body as never), res, () => undefined);
            else res.end();
          } else {
            status = up.status;
            res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "text/plain" }).end((await up.text()).split(key).join("***"));
          }
        }
      }
    } catch {
      if (!res.headersSent) status = 502, reply(res, 502, "API compatible injoignable");
      else res.destroy();
    }
    console.info(`relay ${req.method} ${pathname} ${status}`);
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, o.host ?? "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    containerUrl: `http://host.docker.internal:${port}`,
    openSession() {
      const t = randomBytes(32).toString("hex");
      tokens.add(t);
      return t;
    },
    closeSession: (t) => void tokens.delete(t),
    stop: () => new Promise((resolve) => (server.close(() => resolve()), server.closeAllConnections())),
  };
}
