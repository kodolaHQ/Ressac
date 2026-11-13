import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readAmoKey } from "../host/extensions/amo";
import { CLAUDE_KEY, amoKeychain, keychain } from "../host/keychain";

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
    // Not found under the new name: the old one is looked up (keys saved before the rename).
    expect(l[2]!.argv).toEqual(["find-generic-password", "-s", "webaios-codex-api", "-a", "default", "-w"]);
    expect(l[3]!.argv).toEqual(["delete-generic-password", "-s", "ressac-codex-api", "-a", "default"]);
    expect(l[4]!.argv).toEqual(["delete-generic-password", "-s", "webaios-codex-api", "-a", "default"]);
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

// Keys saved before the rename to Ressac, under webaios-codex-api, webaios-claude-api, webaios-amo.
describe("keys saved before the rename", () => {
  /** A fake `security` holding items by service ({ account, secret }), as the keychain answers: 44 when absent. */
  async function keyring(items: Record<string, { account: string; secret: string }>) {
    const file = path.join(dir, "items.json");
    await writeFile(file, JSON.stringify(items));
    const bin = path.join(dir, "security-items");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require("fs");
const items = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify(items));
const arg = (a, k) => a[a.indexOf(k) + 1];
// No journal: readAmoKey runs two at once, and a shared file read while written breaks.
const run = (a, stdin) => {
  if (a[0] === "-i") {
    const m = /add-generic-password -U -s (\\S+) -a (\\S+) -w "(.*)"/.exec(stdin);
    items[m[1]] = { account: m[2], secret: m[3] };
    return save(), process.exit(0);
  }
  const it = items[arg(a, "-s")];
  if (!it) process.exit(44);
  if (a[0] === "delete-generic-password") return delete items[arg(a, "-s")], save(), process.exit(0);
  process.stdout.write(a.includes("-w") ? it.secret + "\\n" : 'keychain: "acct"<blob>="' + it.account + '"\\n');
  process.exit(0);
};
if (process.argv[2] === "-i") { let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => run(process.argv.slice(2), s)); } else run(process.argv.slice(2), "");
`,
    );
    await chmod(bin, 0o755);
    return { bin, items: async () => JSON.parse(await readFile(file, "utf8")) as Record<string, { account: string; secret: string }> };
  }

  it("a key found only under the old name is read, saved under the new one, and returned", async () => {
    const k = await keyring({ "webaios-codex-api": { account: "default", secret: "sk-old" }, "webaios-claude-api": { account: "default", secret: "sk-ant-old" } });
    expect(await keychain({ command: k.bin }).read()).toBe("sk-old");
    expect(await keychain({ command: k.bin, service: CLAUDE_KEY.service }).has()).toBe(true);
    expect(await k.items()).toMatchObject({ "ressac-codex-api": { account: "default", secret: "sk-old" }, "ressac-claude-api": { account: "default", secret: "sk-ant-old" } });
  });

  it("the new name wins; removing the key removes the old one too (it would come back)", async () => {
    const k = await keyring({ "webaios-codex-api": { account: "default", secret: "sk-old" }, "ressac-codex-api": { account: "default", secret: "sk-new" } });
    const kc = keychain({ command: k.bin });
    expect(await kc.read()).toBe("sk-new");
    await kc.remove();
    expect(await k.items()).toEqual({});
    expect(await kc.read()).toBeNull();
  });

  it("the Mozilla account: found under webaios-amo, saved under ressac-amo; removed from both", async () => {
    const k = await keyring({ "webaios-amo": { account: "user:1:2", secret: "s3" } });
    expect(await readAmoKey({}, { command: k.bin })).toEqual({ emitter: "user:1:2", secret: "s3" });
    expect(await k.items()).toEqual({ "webaios-amo": { account: "user:1:2", secret: "s3" }, "ressac-amo": { account: "user:1:2", secret: "s3" } });
    await amoKeychain({ command: k.bin, env: {} }).remove();
    expect(await k.items()).toEqual({});
  });
});
