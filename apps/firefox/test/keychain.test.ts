import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_KEY, keychain } from "../host/keychain";

let dir: string;
let log: string;
let state: string;
let fake: string;

// The fake `security` appends {argv, stdin} to a journal and answers from a state file: "<code>\n<stdout>".
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kc-"));
  log = path.join(dir, "log.json");
  state = path.join(dir, "state");
  fake = path.join(dir, "security");
  await writeFile(log, "[]");
  await writeFile(state, "0\n");
  await writeFile(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
let stdin = "";
const done = () => {
  const l = JSON.parse(fs.readFileSync(${JSON.stringify(log)}, "utf8"));
  l.push({ argv: process.argv.slice(2), stdin });
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(l));
  const [code, ...out] = fs.readFileSync(${JSON.stringify(state)}, "utf8").split("\\n");
  const rest = out.join("\\n");
  if (rest.startsWith("sleep")) return setTimeout(() => {}, 5000);
  process.stdout.write(rest);
  process.exit(Number(code));
};
if (process.argv[2] === "-i") { process.stdin.on("data", (d) => (stdin += d)); process.stdin.on("end", done); } else done();
`,
  );
  await chmod(fake, 0o755);
});

const journal = async () => JSON.parse(await readFile(log, "utf8")) as { argv: string[]; stdin: string }[];

describe("keychain", () => {
  it("write uses stdin only", async () => {
    await keychain({ command: fake }).write("sk-abc_123");
    const l = await journal();
    expect(l).toHaveLength(1);
    expect(l[0]!.argv).toEqual(["-i"]);
    expect(l[0]!.stdin).toBe('add-generic-password -U -s ressac-codex-api -a default -w "sk-abc_123"\n');
    expect(l.some((e) => e.argv.join(" ").includes("sk-abc_123"))).toBe(false);
  });

  it("rejects odd keys", async () => {
    for (const k of ['sk "x', "sk\nx", "", "a".repeat(513)]) {
      await expect(keychain({ command: fake }).write(k)).rejects.toThrow("Clé invalide");
    }
    expect(await journal()).toEqual([]);
  });

  it("read", async () => {
    const kc = keychain({ command: fake, delayMs: 5000 });
    await writeFile(state, "0\nsk-abc\n");
    expect(await kc.read()).toBe("sk-abc");
    await writeFile(state, "44\n");
    expect(await kc.read()).toBeNull();
    await writeFile(state, "0\nsleep");
    expect(await keychain({ command: fake, delayMs: 50 }).read()).toBeNull();
  });

  it("has and remove", async () => {
    const kc = keychain({ command: fake });
    await writeFile(state, "0\nsecret-output");
    expect(await kc.has()).toBe(true);
    await writeFile(state, "44\n");
    expect(await kc.has()).toBe(false);
    await expect(kc.remove()).resolves.toBeUndefined();
    await writeFile(state, "1\n");
    await expect(kc.remove()).rejects.toThrow();
    await writeFile(state, "44\n");
    const l = await journal();
    expect(l[0]!.argv).not.toContain("-w");
    expect(l[2]!.argv).toEqual(["delete-generic-password", "-s", "ressac-codex-api", "-a", "default"]);
  });

  it("test file", async () => {
    const file = path.join(dir, "kc-file");
    const kc = keychain({ command: fake, env: { RESSAC_TEST_KEYCHAIN: file } });
    expect(await kc.has()).toBe(false);
    await kc.write("sk-1");
    expect(await kc.read()).toBe("sk-1");
    expect(await kc.has()).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await kc.remove();
    expect(await kc.read()).toBeNull();
    await kc.remove();
    expect(await journal()).toEqual([]);
  });

  it("Claude's key: its own service and its own test file", async () => {
    await keychain({ command: fake, service: CLAUDE_KEY.service }).write("sk-ant-1");
    expect((await journal())[0]!.stdin).toBe('add-generic-password -U -s ressac-claude-api -a default -w "sk-ant-1"\n');
    const file = path.join(dir, "kc-file");
    const env = { RESSAC_TEST_KEYCHAIN: file };
    await keychain({ command: fake, env }).write("sk-codex");
    await keychain({ command: fake, env, service: CLAUDE_KEY.service }).write("sk-claude");
    expect(await readFile(file, "utf8")).toBe("sk-codex");
    expect(await readFile(`${file}.claude`, "utf8")).toBe("sk-claude");
    expect(await keychain({ command: fake, env, service: CLAUDE_KEY.service }).read()).toBe("sk-claude");
  });
});
