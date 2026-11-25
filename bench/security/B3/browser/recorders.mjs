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
 *  (`keep` false: no text, for the MCP GET stream that stays open the whole leg). With `hold`, the whole answer is read and
 *  `hold(r)` awaited before the client gets any of it (a tool call's notes are made before the agent can call again). */
async function forward(req, body, url, res, keep = true, hold = null) {
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !DROP_REQ.has(k)));
  const up = await fetch(url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body, redirect: "manual" });
  const out = {};
  up.headers.forEach((v, k) => { if (!DROP_RES.has(k)) out[k] = v; });
  const type = up.headers.get("content-type") ?? "";
  if (hold) {
    const raw = Buffer.from(await up.arrayBuffer());
    const r = { status: up.status, text: raw.toString("utf8"), type };
    try { await hold(r); } finally { res.writeHead(up.status, out).end(raw); }
    return r;
  }
  res.writeHead(up.status, out);
  let text = "";
  const dec = new TextDecoder();
  if (up.body) for await (const c of up.body) { if (keep) text += dec.decode(c, { stream: true }); res.write(c); }
  res.end();
  return { status: up.status, text: text + dec.decode(), type };
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
      if (!e) return void (await forward(req, body, target, res, false));
      await forward(req, body, target, res, true, async (r) => {
        // The answer is JSON or an SSE stream (Streamable HTTP); the one with the call's id is its result.
        const answers = r.type.includes("text/event-stream") ? sseData(r.text) : [parse(r.text)].flat().filter(Boolean);
        const a = answers.find((m) => m.id === call.id);
        if (a?.result) {
          e.result = (a.result.content ?? []).map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
          if (a.result.isError) e.isError = true;
        } else { e.result = a?.error ? `error: ${JSON.stringify(a.error)}` : `HTTP ${r.status}: ${r.text.slice(0, 500)}`; e.isError = true; }
        // A refusal the kernel answers without a card: an attempt blocked (as harness.mts and replay.ts's toolCaller).
        if (o.refusals.some((t) => String(e.result).includes(t))) e.refused = true;
        // As toolCaller: the loads the call caused fall between `seq` and `endSeq`, then the pages a read saw (replay.ts noteReads).
        e.endSeq = o.note("end").seq;
        await o.afterTool?.(e);
      });
    } catch (err) {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(err));
    }
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/mcp`, close: closer(server) };
}

/** The text of a request's last user message (a string, or its text blocks). */
const lastUserText = (body) => {
  const m = (Array.isArray(body?.messages) ? body.messages : []).filter((x) => x?.role === "user").at(-1)?.content;
  return typeof m === "string" ? m : Array.isArray(m) ? m.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
};
/** Token counts in an answer (message_start's message.usage, then message_delta's usage; or a JSON answer's usage). */
const sumUsage = (parts) => { const u = {}; for (const p of parts) for (const [k, v] of Object.entries(p ?? {})) if (typeof v === "number") u[k] = v; return Object.keys(u).length ? u : null; };

/** `seen.agentRequests`: the requests that declared tools and got a 2xx (an agent turn, never a title or a token count);
 *  `seen.firstPrompt`: the first one's last user message. An upstream failure (status >= 400 that is not a rate limit, or a
 *  forward that throws) calls onStop("upstream-<status>"): the pass is broken, never « the model refused ». */
// Ressac's tools, plus the inert marker Claude Code (2.1.325+) adds to keep deferred tool loading on: no input, never executed.
export const safeTool = (t) => String(t.name).startsWith("mcp__ressac__")
  || (t.name === "DeferredToolPlaceholder" && t.defer_loading === true && !Object.keys(t.input_schema?.properties ?? {}).length);

export async function startModelRecorder(o) {
  const seen = { requests: 0, agentRequests: 0, firstPrompt: null };
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
      const why = tools?.some((t) => !safeTool(t)) ? "unsafe-tools" : owner && raw.toLowerCase().includes(owner) ? "owner-email" : null;
      if (why) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `bench recorder: ${why}` } }));
        record({ path: req.url, body: body ?? raw, status: 400, text: "", stop_reason: null, stopped: why });
        o.onStop(why);
        return;
      }
      let r;
      try {
        r = await forward(req, Buffer.from(raw), o.upstream.replace(/\/$/, "") + req.url, res);
      } catch (err) {
        record({ path: req.url, body: body ?? raw, status: 502, text: String(err).slice(0, 2000), stop_reason: null, stopped: "upstream-502" });
        o.onStop("upstream-502");
        throw err;
      }
      let text = "", stop = null;
      const usage = [];
      if (r.type.includes("text/event-stream")) {
        for (const m of sseData(r.text)) {
          if (m.type === "content_block_delta" && m.delta?.type === "text_delta") text += m.delta.text;
          if (m.type === "message_delta" && m.delta?.stop_reason) stop = m.delta.stop_reason;
          if (m.type === "message_start") usage.push(m.message?.usage);
          if (m.type === "message_delta") usage.push(m.usage);
        }
      } else {
        const j = parse(r.text);
        if (Array.isArray(j?.content)) text = j.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        stop = j?.stop_reason ?? null;
        usage.push(j?.usage);
      }
      record({ path: req.url, body: body ?? raw, status: r.status, text: text || (r.status >= 400 ? r.text.slice(0, 2000) : ""), stop_reason: stop, usage: sumUsage(usage) });
      if (r.status === 429 || ((r.status >= 400 || /"type"\s*:\s*"error"/.test(r.text)) && /rate.?limit|too many requests/i.test(r.text))) return o.onStop("rate-limit");
      if (r.status >= 400) return o.onStop(`upstream-${r.status}`);
      // A stream that answers 200 then an error event (an engine not signed in, a model it cannot run).
      if (r.type.includes("text/event-stream") && sseData(r.text).some((m) => m.type === "error")) return o.onStop(`upstream-${r.status}-error`);
      if (tools?.length && seen.agentRequests++ === 0) seen.firstPrompt = lastUserText(body);
      if (tools?.length && stop === "end_turn") o.onTurnEnd(text);
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
  const after = [];
  const rec = await startMcpRecorder({ note, target: () => `http://127.0.0.1:${mcpPort}/mcp`, maxTools: 100, refusals: ["REFUSED-TEXT-OF-THE-KERNEL"], onLimit: () => limits++,
    afterTool: async (e) => { await new Promise((d) => setTimeout(d, 20)); after.push(e.name); } });
  let id = 0;
  const call = (name, args = {}) => fetch(rec.url, { method: "POST", headers: { authorization: "Bearer t0k", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) }).then((r) => r.json().catch(() => r.text()));
  const back = await call("read_tab", { id: 3 });
  assert.equal(back.result.content[0].text, "did read_tab", "the client gets the server's answer");
  const [t1] = events.filter((e) => e.t === "tool");
  assert.deepEqual([t1.name, t1.args, t1.result, t1.isError, t1.refused], ["read_tab", { id: 3 }, "did read_tab", undefined, undefined]);
  assert.ok(t1.endSeq > t1.seq, "endSeq after seq");
  assert.deepEqual(after, ["read_tab"], "afterTool ran on the call, awaited before the next");
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
    if (b.model === "unsigned") return void res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
    if (b.model === "missing") return void res.writeHead(404, { "content-type": "application/json" }).end('{"error":"model not found"}');
    if (b.model === "stream-error") return void res.writeHead(200, { "content-type": "text/event-stream" }).end('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"boom"}}\n\n');
    const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" }).end([{ type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Voi" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ci" } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }, { type: "message_stop" }].map(ev).join(""));
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
  r = await ask({ model: "m", stream: true, tools: [ressacTool, { name: "DeferredToolPlaceholder", input_schema: { type: "object", properties: { cmd: { type: "string" } } }, defer_loading: true }], messages: [] });
  assert.equal(r.status, 400); await r.text();
  assert.deepEqual([stops.at(-1), stops.length, upstreamSeen], ["unsafe-tools", 2, 0], "a placeholder that takes input: refused");
  assert.ok(safeTool({ name: "DeferredToolPlaceholder", input_schema: { type: "object", properties: {} }, defer_loading: true }), "the inert placeholder passes");
  assert.ok(!safeTool({ name: "DeferredToolPlaceholder", input_schema: { type: "object", properties: {} } }), "without defer_loading it does not");
  r = await ask({ model: "m", stream: true, tools: [ressacTool], messages: [{ role: "user", content: "mon e-mail : camille.aubrac@exemple.fr" }] });
  assert.equal(r.status, 400); await r.text();
  assert.deepEqual([stops.at(-1), upstreamSeen], ["owner-email", 0], "the owner's e-mail: refused, nothing forwarded");
  r = await ask({ model: "limited", tools: [ressacTool], messages: [] });
  assert.equal(r.status, 429); await r.text();
  assert.equal(stops.at(-1), "rate-limit", "an upstream 429 stops the run");
  // An upstream failure that is no rate limit: the pass is broken (an engine not signed in, a model it lacks, an error event).
  for (const [m, why] of [["unsigned", "upstream-401"], ["missing", "upstream-404"], ["stream-error", "upstream-200-error"]]) {
    await (await ask({ model: m, stream: true, tools: [ressacTool], messages: [] })).text();
    assert.equal(stops.at(-1), why, `${m}: ${why}`);
  }
  assert.deepEqual(turns, [], "no turn from a failed request");
  r = await ask({ model: "m", stream: true, messages: [] });
  assert.ok((await r.text()).includes("text_delta"), "the client gets the stream");
  assert.deepEqual(turns, [], "no turn end for a request without tools");
  assert.deepEqual([model.seen.agentRequests, model.seen.firstPrompt], [0, null], "no tools or no 2xx: not an agent request");
  await (await ask({ model: "claude-x", stream: true, tools: [ressacTool], messages: [{ role: "user", content: "la tâche" }, { role: "assistant", content: "…" }, { role: "user", content: [{ type: "text", text: "<rappel>" }, { type: "text", text: "le prompt tapé" }] }] })).text();
  assert.deepEqual(turns, ["Voici"], "end_turn on a request with tools: onTurnEnd with its text");
  await (await ask({ model: "claude-x", stream: true, tools: [ressacTool], messages: [{ role: "user", content: "plus tard" }] })).text();
  assert.deepEqual([model.seen.agentRequests, model.seen.firstPrompt], [2, "<rappel>\nle prompt tapé"], "the first agent request's last user message");
  assert.deepEqual([model.seen.model, model.seen.tools, model.seen.userAgent, model.seen.requests], ["claude-x", ["mcp__ressac__read_tab"], "claude-cli/test", 10]);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 10);
  assert.deepEqual(Object.keys(lines.at(-1)), ["at", "path", "body", "status", "text", "stop_reason", "usage"]);
  assert.deepEqual([lines.at(-1).path, lines.at(-1).text, lines.at(-1).stop_reason, lines.at(-1).usage], ["/v1/messages?beta=true", "Voici", "end_turn", { input_tokens: 12, output_tokens: 7 }]);
  await model.close(); await new Promise((d) => up.close(d));
  // A forward that throws (the upstream gone): upstream-502, the client gets a 502.
  const gone = await startModelRecorder({ upstream: `http://127.0.0.1:${upPort}`, file, onTurnEnd: () => {}, onStop: (w) => stops.push(w) });
  r = await fetch(`${gone.url}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", tools: [ressacTool], messages: [] }) });
  assert.deepEqual([r.status, stops.at(-1)], [502, "upstream-502"], "a forward that throws stops the run");
  await r.text(); await gone.close();
  const all = readFileSync(file, "utf8");
  assert.ok(!/camille\.aubrac/i.test(all) && !all.includes("fake-key"), "no owner e-mail and no credential in the file");
  rmSync(dir, { recursive: true, force: true });
  console.log("recorders selftest ok");
}
