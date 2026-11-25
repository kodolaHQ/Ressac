#!/usr/bin/env node
// A fake `claude` for run.mts --self-check (BENCH_CLAUDE): agent-on-mac.mjs runs it with the rewritten argv, in the panel's
// PTY. It shows run.mts's ready marker, takes one typed line, then (STAND_IN_MODE):
//   search (default)  calls search_web through --mcp-config, posts one /v1/messages (the line and the tool's answer) declaring
//                     mcp__ressac__search_web only
//   bash              the same request, also declaring Bash (the model recorder must refuse it)
//   silent            never posts
// and idles until its PTY closes. No model, no network: the request goes to ANTHROPIC_BASE_URL (Ressac's relay).
import { readFileSync } from "node:fs";

const SDK = new URL("../../../../packages/kernel/node_modules/@modelcontextprotocol/sdk/dist/esm/", import.meta.url);
const mode = process.env.STAND_IN_MODE || "search";
const argv = process.argv.slice(2);
const config = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers.ressac;

// run.mts's TUI_READY.
process.stdout.write("stand-in ⏵⏵ bypass permissions on\r\n> ");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let line = "";
let done = false;
process.stdin.on("data", async (chunk) => {
  if (done) return;
  for (const c of chunk.toString("utf8")) {
    if (c !== "\r") { line += c; continue; }
    done = true;
    process.stdout.write(`\r\nstand-in received ${line.length} chars\r\n`);
    try { await act(line); } catch (e) { process.stdout.write(`stand-in error: ${e}\r\n`); }
    return;
  }
});
process.stdin.on("end", () => process.exit(0));

async function act(typed) {
  if (mode === "silent") return;
  const { Client } = await import(new URL("client/index.js", SDK).href);
  const { StreamableHTTPClientTransport } = await import(new URL("client/streamableHttp.js", SDK).href);
  const client = new Client({ name: "stand-in", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  const r = await client.callTool({ name: "search_web", arguments: { query: "horaires piscine", goal: "trouver les horaires" } });
  await client.close();
  const result = r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
  const tools = [{ name: "mcp__ressac__search_web", input_schema: { type: "object" } }, ...(mode === "bash" ? [{ name: "Bash", input_schema: { type: "object" } }] : [])];
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`, "user-agent": "claude-cli/0.0.0-stand-in (external, cli)" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL, stream: true, max_tokens: 100, tools, messages: [{ role: "user", content: typed }, { role: "user", content: result }] }),
  });
  process.stdout.write(`stand-in model answered ${res.status}\r\n`);
  await res.text();
}
