import { expect, test, vi } from "vitest";
import { createAsk } from "../chrome/store/ask";
import type { AgentHost } from "../chrome/agent/host";

const hostWith = (request: (method: string, params?: unknown) => Promise<unknown>) =>
  ({ request: vi.fn(request), notify: vi.fn() }) as unknown as AgentHost & { request: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };

test("host down: find gives the agent, usable is false", async () => {
  const host = hostWith(() => Promise.reject(new Error("down")));
  const ask = createAsk(host, () => {});
  expect(await ask.find("q")).toEqual({ kind: "agent" });
  expect(await ask.usable()).toBe(false);
});

test("find passes the question to the host", async () => {
  const host = hostWith(async () => ({ kind: "page", hits: [] }));
  expect(await createAsk(host, () => {}).find("q")).toEqual({ kind: "page", hits: [] });
  expect(host.request).toHaveBeenCalledWith("ask.find", { question: "q" });
});

test("handOff asks the host, then opens that window's agent", async () => {
  const order: string[] = [];
  const host = hostWith(async (m) => void order.push(m));
  const openAgent = vi.fn(() => void order.push("open"));
  const shown = [{ url: "https://a.test/", title: "A", lastVisit: "2026-11-11T00:00:00Z", excerpt: null, favicon: null }];
  expect(await createAsk(host, openAgent).handOff("w1", "q", shown)).toBe(true);
  expect(host.request).toHaveBeenCalledWith("ask.handOff", { window: "w1", question: "q", shown, space: null });
  expect(openAgent).toHaveBeenCalledWith("w1");
  expect(order).toEqual(["ask.handOff", "open"]);
});

test("handOff refused by the host: false, the panel stays closed", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const openAgent = vi.fn();
  const host = hostWith(() => Promise.reject(new Error("down")));
  expect(await createAsk(host, openAgent).handOff("w1", "q", [])).toBe(false);
  expect(openAgent).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});
