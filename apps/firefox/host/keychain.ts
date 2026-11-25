import { execFile, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { hostSay } from "./locale.ts";

const run = promisify(execFile);

export const CODEX_KEY = { service: "ressac-codex-api", account: "default" };
export const CLAUDE_KEY = { service: "ressac-claude-api", account: "default" };
/** `security`'s exit code for an item not found. */
const ABSENT = 44;
/** How long a `security` call may take (a locked keychain asks for the password). */
export const KEYCHAIN_DELAY_MS = 10_000;
export const KEY_PATTERN = /^[A-Za-z0-9._~+/=:-]{1,512}$/;
export const INVALID_KEY = () => hostSay("host-invalid-key");

export interface Keychain {
  read(): Promise<string | null>;
  has(): Promise<boolean>;
  write(key: string): Promise<void>;
  remove(): Promise<void>;
}

/**
 * A compatible API key in the macOS keychain (Codex's by default). The key goes to `security` through stdin only (never argv, visible in `ps`),
 * and the output of `security` is never logged. `env.RESSAC_TEST_KEYCHAIN` = a file standing in for the keychain (tests, e2e).
 */
export function keychain(o: { service?: string; account?: string; command?: string; delayMs?: number; env?: NodeJS.ProcessEnv } = {}): Keychain {
  const command = o.command ?? "security";
  const timeout = o.delayMs ?? KEYCHAIN_DELAY_MS;
  const service = o.service ?? CODEX_KEY.service;
  const account = o.account ?? CODEX_KEY.account;
  const testFile = (o.env ?? process.env).RESSAC_TEST_KEYCHAIN;
  const file = testFile && service === CLAUDE_KEY.service ? `${testFile}.claude` : testFile;
  const ids = ["-s", service, "-a", account];
  /** The output, or `absent` (not found), or null (locked, refused or too slow). */
  const find = async (extra: string[]): Promise<string | "absent" | null> => {
    try {
      return (await run(command, ["find-generic-password", ...ids, ...extra], { timeout })).stdout;
    } catch (e) {
      // The error holds the command's output, so it is never logged.
      return (e as { code?: unknown }).code === ABSENT ? "absent" : null;
    }
  };
  const readFileKey = () => readFile(file!, "utf8").catch(() => null);
  const self: Keychain = {
    async read() {
      if (file) return readFileKey();
      const found = await find(["-w"]);
      return found === "absent" ? null : (found?.replace(/\r?\n$/, "") ?? null);
    },
    async has() {
      if (file) return (await readFileKey()) !== null;
      const found = await find([]);
      return found !== "absent" && found !== null;
    },
    async write(key) {
      if (!KEY_PATTERN.test(key)) throw new Error(INVALID_KEY());
      if (file) return writeFile(file, key, { mode: 0o600 }).then(() => undefined);
      await new Promise<void>((resolve, reject) => {
        const p = spawn(command, ["-i"], { stdio: ["pipe", "ignore", "ignore"], timeout });
        p.on("error", () => reject(new Error("Écriture au trousseau impossible")));
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("Écriture au trousseau impossible"))));
        p.stdin.on("error", () => reject(new Error("Écriture au trousseau impossible")));
        p.stdin.end(`add-generic-password -U ${ids.join(" ")} -w "${key}"\n`);
      });
    },
    async remove() {
      if (file) return rm(file, { force: true });
      await run(command, ["delete-generic-password", ...ids], { timeout }).catch((e: { code?: unknown }) => {
        if (e.code !== ABSENT) throw new Error("Suppression au trousseau impossible"); // absent = done
      });
    },
  };
  return self;
}

/** The Mozilla (AMO) developer account the agent's extensions were signed with, until 0.1.26. */
export const AMO_SERVICE = "ressac-amo";

/**
 * Deletes every item under AMO_SERVICE (`delete-generic-password` removes one per call: until none is left, 44 = absent).
 * `env.RESSAC_TEST_KEYCHAIN` = its ".amo" file (tests, e2e).
 */
export async function removeAmoAccount(o: { command?: string; delayMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const file = (o.env ?? process.env).RESSAC_TEST_KEYCHAIN;
  if (file) return rm(`${file}.amo`, { force: true });
  for (let i = 0; i < 20; i++) {
    try {
      await run(o.command ?? "security", ["delete-generic-password", "-s", AMO_SERVICE], { timeout: o.delayMs ?? KEYCHAIN_DELAY_MS });
    } catch (e) {
      if ((e as { code?: unknown }).code === ABSENT) return;
      throw new Error("Suppression au trousseau impossible");
    }
  }
}
