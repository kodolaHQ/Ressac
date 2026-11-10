import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDeviceLogin } from "../host/device-login";

let dir = "";
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "device-login-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));
// A fake CLI: records its pid in a file, then runs `body`.
const fake = (body: string) => [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));${body}`];
const alive = () => {
  try {
    process.kill(Number(readFileSync(join(dir, "pid"), "utf8")), 0);
    return true;
  } catch {
    return false;
  }
};

describe("startDeviceLogin", () => {
  it("code found", async () => {
    const l = startDeviceLogin(fake(`console.error("\\x1b[94mhttps://auth.openai.com/codex/device\\x1b[0m");console.error("\\x1b[94mB3MH-2FT21\\x1b[0m");setTimeout(()=>{},60000)`));
    expect(await l.result).toEqual({ kind: "device", url: "https://auth.openai.com/codex/device", code: "B3MH-2FT21" });
    expect(alive()).toBe(true);
    l.stop();
    await vi.waitFor(() => expect(alive()).toBe(false));
  });

  it("exits first", async () => {
    const l = startDeviceLogin(fake(`console.error("Error logging in: boom");process.exit(1)`));
    expect(await l.result).toEqual({ kind: "error", error: "Error logging in: boom" });
  });

  it("too slow", async () => {
    const l = startDeviceLogin(fake(`setTimeout(()=>{},60000)`), { delayMs: 100 });
    expect(await l.result).toMatchObject({ kind: "error" });
    await vi.waitFor(() => expect(alive()).toBe(false));
  });
});
