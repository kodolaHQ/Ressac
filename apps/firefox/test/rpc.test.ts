import { describe, expect, it } from "vitest";
import { OngletIntrouvable } from "../../../packages/noyau/src/mcp/pont";
import { createRpc, type Handler } from "../shared/rpc";

/** Two RPC ends wired in memory; messages are delivered on a later microtask, like a pipe. */
function pair(handlersB: Record<string, Handler>, handlersA: Record<string, Handler> = {}) {
  const sent: string[] = [];
  const a = createRpc({ send: (l) => (sent.push(l), queueMicrotask(() => b.receive(l))), handlers: handlersA });
  const b = createRpc({ send: (l) => (sent.push(l), queueMicrotask(() => a.receive(l))), handlers: handlersB });
  return { a, b, sent };
}

describe("rpc", () => {
  it("answers a request", async () => {
    const { a } = pair({ add: ([x, y]: number[]) => x! + y! });
    expect(await a.request("add", [2, 3])).toBe(5);
  });

  it("rejects with the handler error name and own properties", async () => {
    const { a } = pair({
      read: () => {
        throw new OngletIntrouvable("t9");
      },
    });
    const e = await a.request("read").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ name: "OngletIntrouvable", id: "t9", message: "Onglet introuvable : t9" });
  });

  it("unknown method", async () => {
    const { a, sent } = pair({});
    await expect(a.request("nope")).rejects.toThrow();
    expect(JSON.parse(sent[1]!).error.code).toBe(-32601);
  });

  it("cancels: requester signal aborts the handler signal and rejects with AbortError", async () => {
    let handlerSignal: AbortSignal | undefined;
    const { a, sent } = pair({
      slow: (_p, signal) => {
        handlerSignal = signal;
        return new Promise(() => {});
      },
    });
    const c = new AbortController();
    const p = a.request("slow", {}, c.signal);
    await new Promise((r) => setTimeout(r, 0));
    c.abort();
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DOMException);
    expect((e as DOMException).name).toBe("AbortError");
    await new Promise((r) => setTimeout(r, 0));
    expect(handlerSignal?.aborted).toBe(true);
    expect(sent.some((l) => JSON.parse(l).method === "$/cancel")).toBe(true);
  });

  it("close rejects pending requests", async () => {
    const { a } = pair({ slow: () => new Promise(() => {}) });
    const p = a.request("slow");
    a.close("host gone");
    await expect(p).rejects.toThrow("host gone");
  });

  it("notifications get no answer", async () => {
    let got: unknown;
    const { a, sent } = pair({ ping: (p) => void (got = p) });
    a.notify("ping", { x: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual({ x: 1 });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).not.toHaveProperty("id");
  });
});
