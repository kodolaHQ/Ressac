import { spawn } from "node:child_process";
import type { LoginResult } from "../shared/settings.ts";

export const DEVICE_CODE_DELAY_MS = 30_000;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Runs a sign-in command that prints a page address and a code, then waits for the user to enter it (no TTY).
 * Resolves as soon as both are seen (the process keeps running), or with an error if it ends or is too slow first.
 */
export function startDeviceLogin(command: string[], o: { delayMs?: number } = {}): { result: Promise<LoginResult>; stop(): void } {
  const child = spawn(command[0]!, command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  let timer: NodeJS.Timeout;
  const result = new Promise<LoginResult>((resolve) => {
    const fail = () => {
      child.kill();
      resolve({ kind: "error", error: text.trim().split("\n").slice(-3).join("\n").slice(-300) });
    };
    const look = () => {
      const url = text.match(/https:\/\/\S+/)?.[0];
      const code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0];
      if (url && code) {
        clearTimeout(timer);
        resolve({ kind: "device", url, code });
      }
    };
    const read = (b: Buffer) => {
      text += b.toString().replace(ANSI, "");
      look();
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (e) => {
      text += e.message;
      fail();
    });
    child.on("close", () => {
      clearTimeout(timer);
      fail();
    });
    timer = setTimeout(fail, o.delayMs ?? DEVICE_CODE_DELAY_MS);
  });
  return { result, stop: () => void child.kill() };
}
