import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline, Readable } from "node:stream";
import { NO_KEY } from "./codex-engine";

export type RelayKind = "codex" | "claude";
/** Seen with the real CLIs: Codex calls POST /responses (plan 45 task 1), Claude Code POST /v1/messages (plan 48 task 2; count_tokens is its other endpoint). */
export const RELAY_PATHS: Record<RelayKind, string[]> = { codex: ["/responses"], claude: ["/v1/messages", "/v1/messages/count_tokens"] };
const DROPPED = new Set(["authorization", "x-api-key", "host", "connection", "content-length", "cookie", "proxy-authorization", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer"]);

export interface Relay {
  port: number;
  containerUrl: string;
  /** The token is bound to `target`, the API address when the session opened: a later change does not redirect it. */
  openSession(target: string, kind: RelayKind): string;
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
export async function startRelay(o: { readKey(kind: RelayKind): Promise<string | null>; host?: string; port?: number }): Promise<Relay> {
  const tokens = new Map<string, { target: string; kind: RelayKind }>();
  const server = http.createServer(async (req, res) => {
    const [pathname = "", ...q] = (req.url ?? "").split("?");
    const query = q.length ? "?" + q.join("?") : "";
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    let status = 500;
    try {
      let session: { target: string; kind: RelayKind } | undefined;
      for (const [t, s] of tokens) if (sameToken(t, bearer)) session = s;
      if (!session) status = 401, reply(res, 401, "Jeton invalide");
      else if (!RELAY_PATHS[session.kind].includes(pathname)) status = 404, reply(res, 404, "Introuvable");
      else if (req.method !== "POST") status = 405, reply(res, 405, "Méthode non permise");
      else {
        const key = await o.readKey(session.kind);
        if (!key) status = 503, reply(res, 503, NO_KEY);
        else {
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROPPED.has(k)) headers.set(k, [v].flat().join(", "));
          headers.set("authorization", `Bearer ${key}`);
          // Anthropic reads x-api-key; compatible gateways often read the bearer.
          if (session.kind === "claude") headers.set("x-api-key", key);
          // The container left: stop the upstream call (billed tokens) while waiting for headers and while streaming.
          const ac = new AbortController();
          res.on("close", () => ac.abort());
          const up = await fetch(session.target.replace(/\/$/, "") + pathname + query, {
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
            res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "text/plain", ...(up.headers.get("retry-after") ? { "retry-after": up.headers.get("retry-after")! } : {}) }).end((await up.text()).split(key).join("***"));
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
    openSession(target, kind) {
      const t = randomBytes(32).toString("hex");
      tokens.set(t, { target, kind });
      return t;
    },
    closeSession: (t) => void tokens.delete(t),
    stop: () => new Promise((resolve) => (server.close(() => resolve()), server.closeAllConnections())),
  };
}
