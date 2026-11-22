// B5/B6 driver: a THROWAWAY Lima machine (own temp LIMA_HOME and Ressac root, the pinned VM image), the real Workshop and
// the real kernel (createKernel) on the kernel's FakeBridge, the real relay with a FAKE key and a fake API on the Mac.
// Stays up (the machine stops when this process dies) and takes JS snippets on a local control port.
import http from "node:http";
import net from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const W = (process.env.RESSAC_WORKTREE ?? new URL("../../../..", import.meta.url).pathname);
const { createMachine, vmImage } = await import(`${W}/apps/firefox/host/machine.ts`);
const { startRelay } = await import(`${W}/apps/firefox/host/relay.ts`);
const { claudeEngineEnv } = await import(`${W}/apps/firefox/host/claude-engine.ts`);
const { codexEngineArgs } = await import(`${W}/apps/firefox/host/codex-engine.ts`);
const k = await import(`${W}/packages/kernel/src/index.ts`);
const { FakeBridge } = await import(`${W}/packages/kernel/src/mcp/fake-bridge.ts`);
const { InstructionReview, WATCHED } = await import(`${W}/packages/kernel/src/workspace/instructions.ts`);

const env = (n: string) => process.env[n] ?? (() => { throw new Error(`${n} missing`); })();
const tmp = env("BENCH_TMP"), home = env("LIMA_HOME"), root = env("RESSAC_ROOT");
const tools = { limactl: env("RESSAC_LIMACTL"), podman: env("RESSAC_PODMAN"), template: env("RESSAC_VM_TEMPLATE") };
const engineDir = join(k.DEFAULT_DOCKER_FOLDER, "engine");
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// The fake API (the « engine chosen »): records every request, answers an error so no conversation goes on.
const apiSeen: any[] = [];
const api = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { apiSeen.push({ method: req.method, url: req.url, headers: req.headers, body: b }); res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bench: fake API, no model here" } })); }); });
await new Promise<void>((ok) => api.listen(0, "127.0.0.1", ok));
const apiPort = (api.address() as net.AddressInfo).port;
const KEY = { claude: "sk-" + "ant-FAKEBENCHKEY-0123456789abcdef", codex: "sk-FAKEBENCHOPENAI-fedcba9876543210" };
const relay = await startRelay({ readKey: async (kind: "codex" | "claude") => KEY[kind] });

const machine = createMachine({ ...tools, home, engine: engineDir, ressacRoot: root, busy: async () => true, idleMs: 24 * 3600_000, image: vmImage() });
let kernel: any;
const network = () => ({ ports: [kernel?.mcpPort, relay.port].filter((p: unknown): p is number => typeof p === "number"), domains: [] as string[] });
const paths = k.spacePaths(root);
const workshop = new k.Workshop({ paths, locale: () => "fr", engine: () => machine, network });
log("installing the machine…");
let t = Date.now();
await machine.install();
log(`machine up in ${((Date.now() - t) / 1000).toFixed(0)} s`);
const bridge = new FakeBridge([{ id: "t1", title: "Shop", url: "https://shop.example/", space: "perso" }], { active: "t1", allow: false, search: {}, address: false, widgetData: false });
for (const d of ["widgets", "actions", "recaps"]) mkdirSync(join(tmp, d), { recursive: true });
kernel = await k.createKernel({ bridge, root, workshop, locale: () => "fr", widgetsFolder: join(tmp, "widgets"), actionsFolder: join(tmp, "actions"), recapsFolder: join(tmp, "recaps") });
log(`kernel up, MCP port ${kernel.mcpPort}, relay ${relay.port}, fake API ${apiPort}`);
t = Date.now();
const state = await workshop.ensureStarted();
log(`workshop ${state} in ${((Date.now() - t) / 1000).toFixed(0)} s`);
const review = new InstructionReview(paths, { read: (f: string[], tr: string[]) => workshop.readInstructions(f, tr), write: (e: Record<string, string | null>) => workshop.writeInstructions(e) }, join(W, "packages/kernel/templates"), () => "fr");
const sessions: any[] = [];
const ctx = { k, kernel, workshop, machine, relay, apiSeen, apiPort, KEY, paths, bridge, review, WATCHED, claudeEngineEnv, codexEngineArgs, sessions, root, tmp, tools,
  x: (cmd: string) => workshop.exec(["sh", "-c", cmd]) };
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const control = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", async () => { try { const r = await new AsyncFunction("ctx", b)(ctx); res.end(JSON.stringify(r ?? null, null, 1)); } catch (e) { res.writeHead(500).end(String((e as Error)?.stack ?? e)); } }); });
await new Promise<void>((ok) => control.listen(0, "127.0.0.1", ok));
writeFileSync(join(tmp, "state.json"), JSON.stringify({ control: (control.address() as net.AddressInfo).port, podmanArgs: machine.args(), container: k.containerName(), mcpPort: kernel.mcpPort, relayPort: relay.port, apiPort, state }));
log("READY");
const bye = async () => { log("stopping"); for (const s of sessions) await s.stop().catch(() => {}); await kernel.stop?.().catch(() => {}); await relay.stop().catch(() => {}); await machine.stop().catch(() => {}); process.exit(0); };
process.on("SIGTERM", bye); process.on("SIGINT", bye);
