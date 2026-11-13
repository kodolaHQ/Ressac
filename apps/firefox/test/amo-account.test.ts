import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { KEYS_ABSENT, readAmoKey } from "../host/extensions/amo";
import { amoKeychain } from "../host/keychain";

let dir: string;
let fake: string;
let items: string;
let log: string;

// A fake `security` holding several items under ressac-amo (JSON list of {acct, secret}), journalling every call.
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "amo-kc-"));
  fake = path.join(dir, "security");
  items = path.join(dir, "items.json");
  log = path.join(dir, "log.json");
  await writeFile(items, "[]");
  await writeFile(log, "");
  await writeFile(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
const J = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const argv = process.argv.slice(2);
let stdin = "";
const done = () => {
  // One appended line per call: readAmoKey runs two calls at once, a read-modify-write log would race.
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, stdin }) + "\\n");
  let list = J(${JSON.stringify(items)});
  const save = () => fs.writeFileSync(${JSON.stringify(items)}, JSON.stringify(list));
  if (argv[0] === "-i") {
    const m = /-a (\\S+) -w "([^"]*)"/.exec(stdin);
    list.push({ acct: m[1], secret: m[2] }); save(); return;
  }
  if (!list.length) process.exit(44);
  if (argv[0] === "delete-generic-password") { list.shift(); save(); return; }
  if (argv.includes("-w")) return process.stdout.write(list[0].secret + "\\n");
  process.stdout.write('keychain: "x"\\n    "acct"<blob>="' + list[0].acct + '"\\n');
};
if (argv[0] === "-i") { process.stdin.on("data", (d) => (stdin += d)); process.stdin.on("end", done); } else done();
`,
  );
  await chmod(fake, 0o755);
});

const calls_ = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; stdin: string });
const stored = async () => JSON.parse(await readFile(items, "utf8")) as { acct: string; secret: string }[];

describe("Mozilla account keychain", () => {
  it("set, read, replace: one item left, secret only on stdin", async () => {
    const kc = amoKeychain({ command: fake, env: {} });
    expect(await kc.issuer()).toBeNull();
    await kc.write("user:1:2", "s3cret");
    expect(await kc.issuer()).toBe("user:1:2");
    expect(await readAmoKey({}, { command: fake })).toEqual({ emitter: "user:1:2", secret: "s3cret" });
    // A stale second item (put there by hand) goes too.
    await writeFile(items, JSON.stringify([...(await stored()), { acct: "user:9:9", secret: "old" }]));
    await kc.write("user:3:4", "n3w");
    expect(await stored()).toEqual([{ acct: "user:3:4", secret: "n3w" }]);
    expect(await kc.issuer()).toBe("user:3:4");
    const calls = await calls_();
    expect(calls.some((c) => c.argv.join(" ").includes("n3w"))).toBe(false);
    await kc.remove();
    expect(await stored()).toEqual([]);
    expect(await kc.issuer()).toBeNull();
  });

  it("invalid issuer or secret: INVALID_KEY, nothing written", async () => {
    const kc = amoKeychain({ command: fake, env: {} });
    for (const [i, s] of [["user:1:2", 'a"b'], ["user:1:2", ""], ["bob", "ok"], ["user:1:x", "ok"], ["user:1:2\nx", "ok"]] as const)
      await expect(kc.write(i, s)).rejects.toThrow("Clé invalide");
    expect(await calls_()).toEqual([]);
  });

  it("test keychain file: read by readAmoKey, no real security", async () => {
    const env = { RESSAC_TEST_KEYCHAIN: path.join(dir, "kc") };
    const kc = amoKeychain({ command: "/nonexistent", env });
    expect(await kc.issuer()).toBeNull();
    await kc.write("user:1:2", "s3cret");
    expect(await readAmoKey(env)).toEqual({ emitter: "user:1:2", secret: "s3cret" });
    await kc.remove();
    expect(await readAmoKey(env, { command: "/nonexistent" })).toBeNull();
  });

  it("no key: the sign path's message", () => {
    expect(KEYS_ABSENT).toBe("Compte Mozilla non branché : Réglages › Agents › Compte Mozilla. Rien n'est parti chez Mozilla.");
  });
});
