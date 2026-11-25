#!/usr/bin/env node
// The two recorders of the real-browser replay (B3): an MCP pass-through between the real Claude Code CLI and the real
// kernel's MCP server (every tool call noted as replay.ts's `tool` events), and a model pass-through between the CLI and
// the Anthropic API (every request appended to a file, unsafe requests stopped before they leave the Mac).
//   node recorders.mjs --selftest      in-process fakes only, no model, no network
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// Hop-by-hop or recomputed headers: fetch sets its own, and it decompresses what it reads.
const DROP_REQ = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "keep-alive"]);
const DROP_RES = new Set(["connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive"]);

const readBody = (req) => new Promise((done, fail) => { const b = []; req.on("data", (c) => b.push(c)); req.on("end", () => done(Buffer.concat(b))); req.on("error", fail); });
const listen = (server) => new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port)));
const closer = (server) => () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); });
const parse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
/** The JSON messages of an SSE stream (`data:` lines). */
const sseData = (raw) => raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => parse(l.slice(5).trim())).filter(Boolean);

/** Forwards `req` (its body already read) to `url`; streams the answer back to `res` and resolves with its status and text
 *  (`keep` false: no text, for the MCP GET stream that stays open the whole leg). */
async function forward(req, body, url, res, keep = true) {
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !DROP_REQ.has(k)));
  const up = await fetch(url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, redirect: "manual" });
  const out = {};
  up.headers.forEach((v, k) => { if (!DROP_RES.has(k)) out[k] = v; });
  res.writeHead(up.status, out);
  let text = "";
  const dec = new TextDecoder();
  if (up.body) for await (const c of up.body) { if (keep) text += dec.decode(c, { stream: true }); res.write(c); }
  res.end();
  return { status: up.status, text: text + dec.decode(), type: up.headers.get("content-type") ?? "" };
}

export async function startMcpRecorder(o) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    try {
      const target = o.target();
      if (!target) { res.writeHead(503).end("no MCP target yet"); return; }
      const body = await readBody(req);
      const msg = req.method === "POST" ? parse(body.toString("utf8")) : undefined;
      // A JSON-RPC batch (an array) is forwarded but not noted: the CLI sends none.
      const call = msg && !Array.isArray(msg) && msg.method === "tools/call" ? msg : undefined;
      let e;
      if (call) {
        e = o.note("tool", { name: call.params?.name, args: call.params?.arguments ?? {} });
        if (++calls > o.maxTools) o.onLimit();
      }
      const r = await forward(req, body, target, res, !!e);
      if (!e) return;
      // The answer is JSON or an SSE stream (Streamable HTTP); the one with the call's id is its result.
      const answers = r.type.includes("text/event-stream") ? sseData(r.text) : [parse(r.text)].flat().filter(Boolean);
      const a = answers.find((m) => m.id === call.id);
      if (a?.result) {
        e.result = (a.result.content ?? []).map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
        if (a.result.isError) e.isError = true;
      } else { e.result = a?.error ? `error: ${JSON.stringify(a.error)}` : `HTTP ${r.status}: ${r.text.slice(0, 500)}`; e.isError = true; }
      // A refusal the kernel answers without a card: an attempt blocked (as harness.mts and replay.ts's toolCaller).
      if (o.refusals.some((t) => String(e.result).includes(t))) e.refused = true;
      // As toolCaller: the loads the call caused fall between `seq` and `endSeq`.
      e.endSeq = o.note("end").seq;
    } catch (err) {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(err));
    }
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/mcp`, close: closer(server) };
}

export async function startModelRecorder(o) {
  const seen = { requests: 0 };
  const owner = o.owner?.toLowerCase() || null;
  const ownerRe = owner ? new RegExp(owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : null;
  // The file never holds the owner's address, whatever path it took.
  const record = (r) => { const line = JSON.stringify({ at: new Date().toISOString(), ...r }); appendFileSync(o.file, `${ownerRe ? line.replace(ownerRe, "<owner-email>") : line}\n`); };
  const server = createServer(async (req, res) => {
    try {
      seen.requests++;
      seen.userAgent = req.headers["user-agent"];
      const raw = (await readBody(req)).toString("utf8");
      const body = parse(raw);
      if (body?.model) seen.model = body.model;
      const tools = Array.isArray(body?.tools) ? body.tools : null;
      if (tools) seen.tools = tools.map((t) => t.name);
      // Before anything leaves the Mac: only Ressac's tools (an allowlist), and never the owner's account e-mail.
      const why = tools?.some((t) => !String(t.name).startsWith("mcp__ressac__")) ? "unsafe-tools" : owner && raw.toLowerCase().includes(owner) ? "owner-email" : null;
      if (why) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `bench recorder: ${why}` } }));
        record({ path: req.url, body: body ?? raw, status: 400, text: "", stop_reason: null, stopped: why });
        o.onStop(why);
        return;
      }
      const r = await forward(req, Buffer.from(raw), o.upstream.replace(/\/$/, "") + req.url, res);
      let text = "", stop = null;
      if (r.type.includes("text/event-stream")) {
        for (const m of sseData(r.text)) {
          if (m.type === "content_block_delta" && m.delta?.type === "text_delta") text += m.delta.text;
          if (m.type === "message_delta" && m.delta?.stop_reason) stop = m.delta.stop_reason;
        }
      } else {
        const j = parse(r.text);
        if (Array.isArray(j?.content)) text = j.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        stop = j?.stop_reason ?? null;
      }
      record({ path: req.url, body: body ?? raw, status: r.status, text: text || (r.status >= 400 ? r.text.slice(0, 2000) : ""), stop_reason: stop });
      if (r.status === 429 || ((r.status >= 400 || /"type"\s*:\s*"error"/.test(r.text)) && /rate.?limit|too many requests/i.test(r.text))) o.onStop("rate-limit");
      else if (tools?.length && stop === "end_turn") o.onTurnEnd(text);
    } catch (err) {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(err));
    }
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: closer(server), seen };
}

// ───────────────────────── selftest ─────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--selftest")) {
  const assert = (await import("node:assert/strict")).default;
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // A fake MCP server: answers tools/call in JSON, or in SSE when the tool is `sse_tool`.
  const mcp = createServer(async (req, res) => {
    const m = JSON.parse((await readBody(req)).toString("utf8"));
    assert.equal(req.headers.authorization, "Bearer t0k", "headers kept");
    const reply = { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: m.params?.name === "refuse" ? "REFUSED-TEXT-OF-THE-KERNEL" : `did ${m.params?.name}` }] } };
    if (m.params?.name === "sse_tool") res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  const mcpPort = await listen(mcp);
  const events = [];
  let seq = 0, limits = 0;
  const note = (t, more = {}) => { const e = { seq: ++seq, at: 0, t, ...more }; events.push(e); return e; };
  const rec = await startMcpRecorder({ note, target: () => `http://127.0.0.1:${mcpPort}/mcp`, maxTools: 100, refusals: ["REFUSED-TEXT-OF-THE-KERNEL"], onLimit: () => limits++ });
  let id = 0;
  const call = (name, args = {}) => fetch(rec.url, { method: "POST", headers: { authorization: "Bearer t0k", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) }).then((r) => r.json().catch(() => r.text()));
  const back = await call("read_tab", { id: 3 });
  assert.equal(back.result.content[0].text, "did read_tab", "the client gets the server's answer");
  const [t1] = events.filter((e) => e.t === "tool");
  assert.deepEqual([t1.name, t1.args, t1.result, t1.isError, t1.refused], ["read_tab", { id: 3 }, "did read_tab", undefined, undefined]);
  assert.ok(t1.endSeq > t1.seq, "endSeq after seq");
  await fetch(rec.url, { method: "POST", headers: { authorization: "Bearer t0k", accept: "text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "sse_tool", arguments: {} } }) }).then((r) => r.text());
  assert.equal(events.filter((e) => e.t === "tool").at(-1).result, "did sse_tool", "an SSE answer is parsed");
  await call("refuse");
  assert.equal(events.filter((e) => e.t === "tool").at(-1).refused, true, "a kernel refusal is marked");
  await fetch(rec.url, { method: "POST", headers: { authorization: "Bearer t0k" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/list" }) }).then((r) => r.text());
  assert.equal(events.filter((e) => e.t === "tool").length, 3, "only tools/call is noted");
  for (let i = 3; i < 100; i++) await call("list_tabs");
  assert.equal(limits, 0, "100 calls: no limit");
  await call("list_tabs");
  assert.equal(limits, 1, "the 101st call calls onLimit");
  await rec.close(); await new Promise((d) => mcp.close(d));

  // A fake Anthropic upstream: SSE for a streamed request, 429 when the model is `limited`.
  let upstreamSeen = 0;
  const up = createServer(async (req, res) => {
    upstreamSeen++;
    const b = JSON.parse((await readBody(req)).toString("utf8"));
    if (b.model === "limited") return void res.writeHead(429, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}');
    const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" }).end([{ type: "message_start", message: {} }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Voi" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ci" } }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }].map(ev).join(""));
  });
  const upPort = await listen(up);
  const dir = mkdtempSync(join(tmpdir(), "ressac-b3-rec-"));
  const file = join(dir, "model.jsonl");
  const stops = [], turns = [];
  const model = await startModelRecorder({ upstream: `http://127.0.0.1:${upPort}`, file, owner: "Camille.Aubrac@exemple.fr", onTurnEnd: (t) => turns.push(t), onStop: (w) => stops.push(w) });
  const ask = (b) => fetch(`${model.url}/v1/messages?beta=true`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "fake-key", "user-agent": "claude-cli/test" }, body: JSON.stringify(b) });
  const ressacTool = { name: "mcp__ressac__read_tab", input_schema: {} };
  let r = await ask({ model: "m", stream: true, tools: [ressacTool, { name: "Bash", input_schema: {} }], messages: [] });
  assert.equal(r.status, 400); await r.text();
  assert.deepEqual([stops, upstreamSeen], [["unsafe-tools"], 0], "a built-in tool: refused, nothing forwarded");
  r = await ask({ model: "m", stream: true, tools: [ressacTool], messages: [{ role: "user", content: "mon e-mail : camille.aubrac@exemple.fr" }] });
  assert.equal(r.status, 400); await r.text();
  assert.deepEqual([stops.at(-1), upstreamSeen], ["owner-email", 0], "the owner's e-mail: refused, nothing forwarded");
  r = await ask({ model: "limited", tools: [ressacTool], messages: [] });
  assert.equal(r.status, 429); await r.text();
  assert.equal(stops.at(-1), "rate-limit", "an upstream 429 stops the run");
  r = await ask({ model: "m", stream: true, messages: [] });
  assert.ok((await r.text()).includes("text_delta"), "the client gets the stream");
  assert.deepEqual(turns, [], "no turn end for a request without tools");
  await (await ask({ model: "claude-x", stream: true, tools: [ressacTool], messages: [] })).text();
  assert.deepEqual(turns, ["Voici"], "end_turn on a request with tools: onTurnEnd with its text");
  assert.deepEqual([model.seen.model, model.seen.tools, model.seen.userAgent, model.seen.requests], ["claude-x", ["mcp__ressac__read_tab"], "claude-cli/test", 5]);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 5);
  assert.deepEqual(Object.keys(lines.at(-1)), ["at", "path", "body", "status", "text", "stop_reason"]);
  assert.deepEqual([lines.at(-1).path, lines.at(-1).text, lines.at(-1).stop_reason], ["/v1/messages?beta=true", "Voici", "end_turn"]);
  const all = readFileSync(file, "utf8");
  assert.ok(!/camille\.aubrac/i.test(all) && !all.includes("fake-key"), "no owner e-mail and no credential in the file");
  await model.close(); await new Promise((d) => up.close(d));
  rmSync(dir, { recursive: true, force: true });
  console.log("recorders selftest ok");
}
