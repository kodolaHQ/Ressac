// A fake `codex app-server` for the chat adapter tests and the chat e2e (fake-docker.cjs runs it for a pipe session):
// logs every line it receives (and its argv) to FAKE_CODEX_LOG, answers by method, scripts a turn by its prompt text.
// FAKE_CHAT_GO (e2e): a « Bonjour » turn streams its start, then holds until the test writes that file.
const fs = require("node:fs");
const log = (m) => fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(m) + "\n");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const note = (method, params) => send({ method, params });
let turn = 0, current = "", waiting = null, held;
const done = (status, error) => note("turn/completed", { threadId: "thr", turn: { id: current, status, items: [], error: error ?? null } });
const delta = (itemId, d) => note("item/agentMessage/delta", { threadId: "thr", turnId: current, itemId, delta: d });
const message = (itemId, text) => note("item/completed", { threadId: "thr", turnId: current, item: { type: "agentMessage", id: itemId, text } });
const msg = (text) => (delta("msg_1", "Bon"), delta("msg_1", "jour"), message("msg_1", text));
const hold = (then) => {
  const go = process.env.FAKE_CHAT_GO;
  const tick = () => (!go || fs.existsSync(go) ? ((held = undefined), then()) : (held = setTimeout(tick, 50)));
  tick();
};
if (process.argv.length > 2) log({ argv: process.argv.slice(2) });
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.id === "srv_1" && waiting) return void (waiting(), (waiting = null));
  switch (m.method) {
    case "initialize": return send({ id: m.id, result: { userAgent: "fake" } });
    case "model/list":
      return send({ id: m.id, result: { nextCursor: null, data: [
        { id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", description: "Frontier", hidden: false, isDefault: true },
        { id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4", description: "Fast", hidden: false, isDefault: false },
        { id: "old", model: "old", displayName: "Old", description: "", hidden: true, isDefault: false },
      ] } });
    case "thread/start": return send({ id: m.id, result: { thread: { id: "thr_new" } } });
    case "thread/resume": return send({ id: m.id, result: { thread: { id: m.params.threadId } } });
    case "turn/interrupt": clearTimeout(held); send({ id: m.id, result: {} }); return done("interrupted");
    case "turn/start": {
      current = "turn_" + ++turn;
      send({ id: m.id, result: { turn: { id: current, status: "inProgress", items: [] } } });
      note("turn/started", { threadId: "thr", turn: { id: current, status: "inProgress", items: [] } });
      const text = m.params.input[0].text;
      if (text === "hello") return msg("Bonjour"), done("completed");
      if (text === "tool") {
        const item = { type: "mcpToolCall", id: "call_1", server: "ressac", tool: "read_tab", arguments: { id: 7 }, status: "inProgress" };
        note("item/started", { threadId: "thr", turnId: current, item });
        note("item/completed", { threadId: "thr", turnId: current, item: { ...item, status: "completed" } });
        return done("completed");
      }
      if (text === "approve") {
        waiting = () => done("completed");
        return send({ id: "srv_1", method: "item/commandExecution/requestApproval", params: { threadId: "thr", turnId: current, itemId: "c" } });
      }
      if (text === "ask") {
        waiting = () => done("completed");
        return send({ id: "srv_1", method: "item/tool/requestUserInput", params: { threadId: "thr", turnId: current, itemId: "i",
          questions: [{ id: "q1", header: "Couleur", question: "Quelle couleur ?", options: [{ label: "Bleu", description: "le ciel" }] }] } });
      }
      if (text === "unauth") return done("failed", { message: "401 Unauthorized", codexErrorInfo: "unauthorized" });
      if (text.includes("Bonjour")) {
        const id = `msg_b${turn}`;
        delta(id, "Bonjour, ");
        return hold(() => (delta(id, "Camille."), message(id, "Bonjour, Camille."), done("completed")));
      }
      return; // "wait": runs until turn/interrupt
    }
  }
});
