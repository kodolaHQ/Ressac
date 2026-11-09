// Harvester: runs in the `workshop` container (no network), plain JavaScript, no dependency.
// Single channel with the kernel: one JSON line per message on stdin / stdout.
// Usage: node harvester.mjs <widget folder>
//
// The kernel sends `start` (with its `workflow`: for a widget that only has `harvest.mjs`, the implicit workflow
// harvest → output; for a builder try, `replay`), then the `memory` line; the workflow is run by
// the interpreter (`block` and `log` traces, `memory` just before `end`, except for a try). With `progressive`,
// the `memory` line also comes along the way and before `failure` (the last one received counts); `limitMs` replaces
// the 150 s limit; if the output publishes as it goes, `publication` lines show the finished items.
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { deadlineOf, runWorkflow } from "./interpreter.mjs";
import { format } from "./webaios.mjs";

const LINE_MAX = 4 * 1024 * 1024;
const output = process.stdout;

// Everything the widget displays goes to stderr: stdout is reserved for the protocol.
const toStderr = (...a) => process.stderr.write(format(...a) + "\n");
console.log = console.info = console.debug = toStderr;

function send(message) {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line) > LINE_MAX) throw new Error("message trop gros (4 Mo maximum)");
  output.write(line + "\n");
}

function finish(message, code) {
  output.write(JSON.stringify(message) + "\n", () => process.exit(code));
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Map();
let counter = 0;
let start;
let startReceivedAt;
let signalStart;
const startReceived = new Promise((ok) => (signalStart = ok));
let memory;
let signalMemory;
const memoryReceived = new Promise((ok) => (signalMemory = ok));

rl.on("line", (line) => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > LINE_MAX) {
    const n = /"n"\s*:\s*(\d+)/.exec(line.slice(0, 256));
    const waiting = n && pending.get(Number(n[1]));
    if (waiting) {
      pending.delete(Number(n[1]));
      waiting.ko(new Error("Réponse trop grande (4 Mo maximum)"));
    } else {
      finish({ t: "failure", error: "Réponse trop grande (4 Mo maximum)" }, 1);
    }
    return;
  }
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.t === "start" && !start) {
    start = m;
    startReceivedAt = Date.now();
    signalStart();
  } else if (m.t === "memory" && start && memory === undefined) {
    memory = m.memory !== null && typeof m.memory === "object" && !Array.isArray(m.memory) ? m.memory : {};
    signalMemory();
  } else if (m.t === "answer" && pending.has(m.n)) {
    const { ok, ko } = pending.get(m.n);
    pending.delete(m.n);
    if (typeof m.error === "string") ko(new Error(m.error));
    else ok(m.ok);
  }
});
rl.on("close", () => {
  for (const { ko } of pending.values()) ko(new Error("le noyau a fermé le canal"));
  pending.clear();
});

function call(f, a) {
  const n = ++counter;
  return new Promise((ok, ko) => {
    pending.set(n, { ok, ko });
    try {
      send({ t: "call", n, f, a });
    } catch (e) {
      pending.delete(n);
      ko(e);
    }
  });
}

async function main() {
  const folder = resolve(process.argv[2] ?? "/widget");
  await startReceived;
  if (!start.workflow) throw new Error("start sans workflow");
  await memoryReceived;
  const r = await runWorkflow({
    workflow: start.workflow,
    config: start.config ?? null,
    memory,
    now: start.now ?? new Date().toISOString(),
    previous: start.previous ?? null,
    folder,
    call,
    trace: send,
    deadline: deadlineOf(start, startReceivedAt),
    toStderr,
    replay: start.replay ?? null,
    // Long or as-it-goes run: memory sent along the way (`memory` lines) and before `failure`.
    progressive: start.progressive === true,
    // Action only: the input (templates, `ctx.userInput`, `webaios.input`) and the progress of per-item blocks.
    input: typeof start.input === "string" ? start.input : undefined,
    progress: start.progress === true,
  });
  // A try (replay) returns no memory: the kernel keeps none.
  if (!start.replay) {
    try {
      send({ t: "memory", memory: r.memory });
    } catch (e) {
      // Too big for a line: the kernel keeps the old one.
      toStderr(`mémoire non envoyée : ${e.message}`);
    }
  }
  send({ t: "end", data: r.data });
  output.write("", () => process.exit(0));
}

main().catch((e) => finish({ t: "failure", error: String(e?.message ?? e) }, 1));
