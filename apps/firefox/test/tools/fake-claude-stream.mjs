// A fake `claude -p --input-format stream-json --output-format stream-json` for the chat adapter tests and the chat e2e
// (fake-docker.cjs runs it for a pipe session). It answers the SDK's control protocol and plays a scripted turn per user
// text. Every line it reads, and its argv, go to FAKE_CLAUDE_LOG (one JSON per line) so a test can check what the SDK sent.
// FAKE_CHAT_GO (e2e): a « Bonjour » turn streams its start, then holds until the test writes that file.
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (o) => process.env.FAKE_CLAUDE_LOG && appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(o) + "\n");
const out = (o) => process.stdout.write(JSON.stringify({ session_id: "s1", uuid: crypto.randomUUID(), ...o }) + "\n");
const result = (o) => out({ type: "result", subtype: "success", is_error: false, result: "", stop_reason: "end_turn", total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 2 }, duration_ms: 1, duration_api_ms: 1, num_turns: 1, permission_denials: [], ...o });
const text = (id, t) => out({ type: "assistant", parent_tool_use_id: null, message: { id, type: "message", role: "assistant", model: "m", content: [{ type: "text", text: t }], stop_reason: null, usage: {} } });
const delta = (t) => out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } });

log({ argv: process.argv.slice(2) });
let askId = "";
let n = 0;
/** The held rest of a « Bonjour » turn, polled until FAKE_CHAT_GO exists; an interrupt drops it. */
let held;
const hold = (then) => {
  const go = process.env.FAKE_CHAT_GO;
  const tick = () => (!go || existsSync(go) ? ((held = undefined), then()) : (held = setTimeout(tick, 50)));
  tick();
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.type === "control_request" && m.request.subtype === "initialize") {
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands: [], agents: [], models: [], output_style: "default", available_output_styles: [], account: { tokenSource: process.env.FAKE_TOKEN_SOURCE ?? "claude.ai" } } } });
    out({ type: "system", subtype: "init", apiKeySource: "none", tools: [], mcp_servers: [], model: "m", permissionMode: "default" });
  } else if (m.type === "control_request" && m.request.subtype === "interrupt") {
    clearTimeout(held);
    out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
    result({ subtype: "error_during_execution", is_error: true, errors: [], stop_reason: null });
  } else if (m.type === "control_response" && m.response.request_id === askId) {
    result({ result: "ok" });
  } else if (m.type === "user") {
    const said = typeof m.message.content === "string" ? m.message.content : m.message.content.map((b) => b.text ?? "").join("");
    if (said === "hello") {
      out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_1" } } });
      delta("Bon");
      delta("jour");
      text("msg_1", "Bonjour");
      result({ result: "Bonjour" });
    } else if (said === "tool") {
      out({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_2", role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "mcp__ressac__read_tab", input: { id: "t1" } }] } });
      out({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "page" }] } });
      result({});
    } else if (said === "ask") {
      askId = `ask_${++n}`;
      const input = { questions: [{ question: "Quel train ?", header: "Train", options: [{ label: "8 h 04", description: "" }, { label: "9 h 12", description: "" }], multiSelect: false }] };
      out({ type: "control_request", request_id: askId, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input, tool_use_id: "tu_ask", permission_suggestions: [] } });
    } else if (said === "auth") {
      result({ is_error: true, result: "Not logged in · Please run /login", api_error_status: 401 });
    } else if (said === "error") {
      result({ is_error: true, result: "Overloaded: request not authorized to retry (529)" });
    } else if (said === "exit") {
      process.exit(3);
    } else if (said.includes("Bonjour")) {
      out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_b" } } });
      delta("Bonjour, ");
      hold(() => (delta("Camille."), text("msg_b", "Bonjour, Camille."), result({ result: "Bonjour, Camille." })));
    } else if (said !== "wait") {
      text(`msg_${++n}`, "Bien reçu.");
      result({ result: "Bien reçu." });
    }
    // "wait": nothing until an interrupt.
  }
});
process.stdin.on("end", () => process.exit(0));
