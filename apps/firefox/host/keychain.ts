import { execFile, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { KEYCHAIN_DELAY_MS, readAmoKey } from "./extensions/amo";

const run = promisify(execFile);

export const CODEX_KEY = { service: "webaios-codex-api", account: "default" };
export const CLAUDE_KEY = { service: "webaios-claude-api", account: "default" };
export const KEY_PATTERN = /^[A-Za-z0-9._~+/=:-]{1,512}$/;
export const INVALID_KEY = "Clé invalide : lettres, chiffres et . _ ~ + / = : - seulement";

export interface Keychain {
  read(): Promise<string | null>;
  has(): Promise<boolean>;
  write(key: string): Promise<void>;
  remove(): Promise<void>;
}

/**
 * A compatible API key in the macOS keychain (Codex's by default). The key goes to `security` through stdin only (never argv, visible in `ps`),
 * and the output of `security` is never logged. `env.WEBAIOS_TEST_KEYCHAIN` = a file standing in for the keychain (tests, e2e).
 */
export function keychain(o: { service?: string; account?: string; command?: string; delayMs?: number; env?: NodeJS.ProcessEnv } = {}): Keychain {
  const command = o.command ?? "security";
  const timeout = o.delayMs ?? KEYCHAIN_DELAY_MS;
  const service = o.service ?? CODEX_KEY.service;
  const account = o.account ?? CODEX_KEY.account;
  const testFile = (o.env ?? process.env).WEBAIOS_TEST_KEYCHAIN;
  const file = testFile && service === CLAUDE_KEY.service ? `${testFile}.claude` : testFile;
  const ids = ["-s", service, "-a", account];
  const find = async (extra: string[]) => {
    try {
      return (await run(command, ["find-generic-password", ...ids, ...extra], { timeout })).stdout;
    } catch {
      // Absent, locked, refused or too slow: the error holds the command's output, so it is never logged.
      return null;
    }
  };
  const readFileKey = () => readFile(file!, "utf8").catch(() => null);
  return {
    read: async () => (file ? readFileKey() : ((await find(["-w"]))?.replace(/\r?\n$/, "") ?? null)),
    has: async () => (file ? (await readFileKey()) !== null : (await find([])) !== null),
    async write(key) {
      if (!KEY_PATTERN.test(key)) throw new Error(INVALID_KEY);
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
        if (e.code !== 44) throw new Error("Suppression au trousseau impossible"); // 44 = absent = done
      });
    },
  };
}

export const AMO_SERVICE = "webaios-amo";
export const ISSUER_PATTERN = /^user:\d+:\d+$/;

/**
 * The Mozilla (AMO) developer account: the JWT issuer is the item's account, the JWT secret its password. Only one item stays under the service.
 * `env.WEBAIOS_TEST_KEYCHAIN` = a ".amo" file holding "issuer:secret" (tests, e2e).
 */
export function amoKeychain(o: { command?: string; delayMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const env = o.env ?? process.env;
  const command = o.command ?? "security";
  const file = env.WEBAIOS_TEST_KEYCHAIN && `${env.WEBAIOS_TEST_KEYCHAIN}.amo`;
  const remove = async () => {
    if (file) return rm(file, { force: true });
    // `delete-generic-password` removes one item per call: go on until none is left (44 = absent).
    for (let i = 0; i < 20; i++) {
      try {
        await run(command, ["delete-generic-password", "-s", AMO_SERVICE], { timeout: o.delayMs ?? KEYCHAIN_DELAY_MS });
      } catch (e) {
        if ((e as { code?: unknown }).code === 44) return;
        throw new Error("Suppression au trousseau impossible");
      }
    }
  };
  return {
    /** The saved issuer (the secret never leaves the keychain), or null. */
    issuer: async () => (await readAmoKey(env, { command, delay: o.delayMs }))?.emitter ?? null,
    async write(issuer: string, secret: string) {
      if (!ISSUER_PATTERN.test(issuer) || !KEY_PATTERN.test(secret)) throw new Error(INVALID_KEY);
      if (file) return writeFile(file, `${issuer}:${secret}`, { mode: 0o600 });
      await remove();
      await keychain({ service: AMO_SERVICE, account: issuer, command, delayMs: o.delayMs, env: {} }).write(secret);
    },
    remove,
  };
}
export type AmoKeychain = ReturnType<typeof amoKeychain>;
