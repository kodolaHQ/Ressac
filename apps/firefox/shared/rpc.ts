// JSON-RPC 2.0 over a line channel, shared by the agent host (Node) and Firefox: no imports on purpose.

export type Handler = (params: any, signal: AbortSignal) => unknown | Promise<unknown>;

export interface Rpc {
  /** One JSON message, no newline. */
  receive(line: string): void;
  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  notify(method: string, params?: unknown): void;
  /** Rejects every pending request with Error(reason) and aborts the handlers still running. */
  close(reason: string): void;
}

interface Message {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

export const CANCEL = "$/cancel";

export function createRpc(o: { send(line: string): void; handlers: Record<string, Handler> }): Rpc {
  let next = 1;
  let closed: string | null = null;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  const running = new Map<number, AbortController>();
  const send = (m: Omit<Message, "jsonrpc">) => o.send(JSON.stringify({ jsonrpc: "2.0", ...m }));

  const answer = async (id: number, method: string, params: unknown) => {
    const handler = Object.hasOwn(o.handlers, method) ? o.handlers[method] : undefined;
    if (!handler) return send({ id, error: { code: -32601, message: `Méthode inconnue : ${method}` } });
    const c = new AbortController();
    running.set(id, c);
    try {
      send({ id, result: (await handler(params, c.signal)) ?? null });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // Own enumerable properties carry the error's fields (TabNotFound.id, ProfileDenied.profil…).
      const error = { code: -32000, message: err.message };
      try {
        send({ id, error: { ...error, data: { ...err, name: err.name } } });
      } catch {
        // A property JSON cannot encode (cycle, BigInt): the name alone still reaches the requester.
        send({ id, error: { ...error, data: { name: err.name } } });
      }
    } finally {
      running.delete(id);
    }
  };

  return {
    receive(line) {
      let m: Message;
      try {
        m = JSON.parse(line) as Message;
      } catch {
        return;
      }
      if (m.method === CANCEL) return void running.get((m.params as { id?: number } | undefined)?.id ?? -1)?.abort();
      if (m.method !== undefined) {
        if (m.id !== undefined) void answer(m.id, m.method, m.params);
        else if (Object.hasOwn(o.handlers, m.method)) void Promise.resolve().then(() => o.handlers[m.method!]!(m.params, new AbortController().signal)).catch(() => {});
        return;
      }
      const p = m.id === undefined ? undefined : pending.get(m.id);
      if (!p) return;
      pending.delete(m.id!);
      if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }, m.error.data));
      else p.resolve(m.result);
    },
    request<T>(method: string, params?: unknown, signal?: AbortSignal) {
      if (closed !== null) return Promise.reject(new Error(closed));
      if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
      const id = next++;
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          if (!pending.delete(id)) return;
          send({ method: CANCEL, params: { id } });
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const done = () => signal?.removeEventListener("abort", onAbort);
        pending.set(id, {
          resolve: (v) => (done(), resolve(v as T)),
          reject: (e) => (done(), reject(e)),
        });
        send({ id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    notify(method, params) {
      send({ method, ...(params === undefined ? {} : { params }) });
    },
    close(reason) {
      closed = reason;
      for (const p of pending.values()) p.reject(new Error(reason));
      pending.clear();
      for (const c of running.values()) c.abort();
    },
  };
}
