// Dev command: the real agent in the container, plugged into a fake browser.
// Usage: corepack pnpm dev:kernel   (Ctrl-] to quit)
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernel, WorkshopError } from "../kernel.js";
import { FakeBridge } from "../mcp/fake-bridge.js";
import type { TabInfo, BrowserBridge } from "../mcp/bridge.js";

const github: TabInfo = { id: "github", title: "sveltejs/svelte", url: "https://github.com/sveltejs/svelte", space: "perso" };
const gmail: TabInfo = { id: "gmail", title: "Gmail — Boîte de réception", url: "https://mail.google.com/mail/u/0/", space: "perso" };
const CTRL_BRACKET = "\x1d";

const fake = new FakeBridge([github, gmail], { active: "github", allow: false });
let log = "";

// The call log goes into a file: writing on stderr would damage the display of the agent's terminal.
const bridge = new Proxy(fake, {
  get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      if (log) appendFileSync(log, `${new Date().toISOString()} ${String(key)} ${JSON.stringify(args)}\n`);
      // No real browser yet: the tabs opened by the agent open in the default browser.
      if (key === "openTab") execFile("open", [String(args[0])]);
      return value.apply(target, args);
    };
  },
}) as BrowserBridge;

// Widgets' and actions' data: outside the workspace, in a temporary folder (no browser profile here).
const kernel = await createKernel({ bridge: bridge, widgetsFolder: join(tmpdir(), "ressac-dev-widgets"), actionsFolder: join(tmpdir(), "ressac-dev-actions") });
log = join(kernel.paths.internal, "dev-pont.log");
console.log(`Space: ${kernel.paths.root}\nFake browser calls: tail -f ${log}\nCtrl-] to quit.\n`);

let session;
try {
  session = await kernel.openAgentSession({ cols: process.stdout.columns ?? 100, rows: process.stdout.rows ?? 30 });
  // After opening: a new session starts without authorization.
  kernel.policy.userInteraction(github); // the user « talks to the agent » from the GitHub tab
} catch (e) {
  console.error(e instanceof WorkshopError ? `Agent indisponible : ${e.message}` : e);
  await kernel.stop();
  process.exit(1);
}

const quit = async (code: number) => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  session.stop();
  await kernel.stop();
  console.log(`\nCalls received: ${fake.calls.map((a) => a.method).join(", ") || "none"}`);
  process.exit(code);
};

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => (d === CTRL_BRACKET ? void quit(0) : session.write(d)));
process.stdout.on("resize", () => session.resize(process.stdout.columns, process.stdout.rows));
session.onData((d) => process.stdout.write(d));
session.onEnd((code) => void quit(code));
