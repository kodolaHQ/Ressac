import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createRpc } from "../shared/rpc";

const app = join(import.meta.dirname, "..");
const kernel = join(app, "..", "..", "packages", "kernel");
let tmp = "";

beforeAll(() => {
  execFileSync("corepack", ["pnpm", "run", "build:host"], { cwd: app, stdio: "pipe" });
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "webaios-bundle-")));
  // The shipped layout: host.mjs, node_modules/node-pty, kernel/{templates,extensions,docker}.
  cpSync(join(app, "dist-host", "host.mjs"), join(tmp, "host.mjs"));
  cpSync(realpathSync(join(kernel, "node_modules", "node-pty")), join(tmp, "node_modules", "node-pty"), { recursive: true });
  for (const d of ["templates", "extensions", "docker"]) cpSync(join(kernel, d), join(tmp, "kernel", d), { recursive: true });
}, 120_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

it("the compiled host runs alone and finds its kernel resources", { timeout: 30_000 }, async () => {
  const dataDir = join(tmp, "data");
  mkdirSync(dataDir);
  const root = join(dataDir, "workspace");
  const child = spawn(process.execPath, [join(tmp, "host.mjs")], {
    cwd: tmp,
    env: {
      ...process.env,
      WEBAIOS_KERNEL_RESOURCES: join(tmp, "kernel"),
      WEBAIOS_DATA_DIR: dataDir,
      // The host must not start the machine's real Ollama or container app.
      WEBAIOS_TEST_NO_SYSTEM: "1",
      WEBAIOS_ROOT: root,
      WEBAIOS_HOST_TEST: "1",
      WEBAIOS_PORT_MCP_EXTERNAL: "0",
      PATH: `${join(app, "test", "tools")}:${process.env.PATH}`,
    },
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const rpc = createRpc({ send: (l) => child.stdin.write(l + "\n"), handlers: {} });
  createInterface({ input: child.stdout }).on("line", (l) => rpc.receive(l));
  try {
    expect(await rpc.request("start", { agentProfile: "claude" })).toEqual({ agent: expect.any(String) });
  } catch (e) {
    throw new Error(`${e}\n${err}`);
  } finally {
    child.kill("SIGKILL");
  }
  const template = readdirSync(join(kernel, "templates"))[0]!;
  expect(existsSync(join(root, template))).toBe(true);
  const text = readFileSync(join(tmp, "host.mjs"), "utf8");
  expect(text).not.toContain(homedir());
  expect(text).not.toContain(join(app, ".."));
});
