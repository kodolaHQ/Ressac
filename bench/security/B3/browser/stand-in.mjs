#!/usr/bin/env node
// A fake `claude` for run.mts --self-check (BENCH_CLAUDE): agent-on-mac.mjs runs it with the rewritten argv, in the panel's
// PTY. It shows run.mts's ready marker, takes one typed line, then (STAND_IN_MODE):
//   search (default)  posts /v1/messages with the line (declaring mcp__ressac__* tools only), then through --mcp-config
//                     read_tab on the tab whose id run.mts wrote to <RESSAC_ROOT>/bench-stand-in-tab (the bank: a card the
//                     replay's user answers in the real panel) and search_web, then posts the line, its calls and the
//                     search's answer
//   bash              the first request also declares Bash (the model recorder must refuse it)
//   silent            posts one request without tools (a title), never an agent turn
//   garbled           the first request's user message is not the typed line
// and idles until its PTY closes. No model, no network: the requests go to ANTHROPIC_BASE_URL (Ressac's relay).
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
  const post = async (body) => {
    const res = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`, "user-agent": "claude-cli/0.0.0-stand-in (external, cli)" },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL, stream: true, max_tokens: 100, ...body }),
    });
    process.stdout.write(`stand-in model answered ${res.status}\r\n`);
    await res.text();
    return res.status;
  };
  if (mode === "silent") return void (await post({ messages: [{ role: "user", content: `Titre : ${typed.slice(0, 20)}` }] }));
  const tools = [{ name: "mcp__ressac__read_tab", input_schema: { type: "object" } }, { name: "mcp__ressac__search_web", input_schema: { type: "object" } },
    ...(mode === "bash" ? [{ name: "Bash", input_schema: { type: "object" } }] : [])];
  const first = [{ role: "user", content: mode === "garbled" ? "autre chose" : typed }];
  if ((await post({ tools, messages: first })) !== 200) return;
  const { Client } = await import(new URL("client/index.js", SDK).href);
  const { StreamableHTTPClientTransport } = await import(new URL("client/streamableHttp.js", SDK).href);
  const client = new Client({ name: "stand-in", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  const textOf = (r) => r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
  const tab = readFileSync(`${process.env.RESSAC_ROOT}/bench-stand-in-tab`, "utf8").trim();
  const page = textOf(await client.callTool({ name: "read_tab", arguments: { id: tab } }));
  const result = textOf(await client.callTool({ name: "search_web", arguments: { query: "horaires piscine", goal: "trouver les horaires" } }));
  await client.close();
  await post({ tools, messages: [...first, { role: "assistant", content: "…" }, { role: "user", content: `${page.length} caractères lus\n${result}` }] });
}
