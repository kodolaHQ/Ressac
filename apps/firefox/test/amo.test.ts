import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AMO_URL, SignatureError, SLOW_SIGNATURE, readAmoKey, signatureImpossible, deniedSignature, sign } from "../host/extensions/amo";
import { addonIdOf, firefoxManifest, firefoxDenial, zipper } from "../host/extensions/firefox-copy";
import { DEFAULT_GUARDS, prepareCopy } from "../../../packages/kernel/src/index.ts";
import { startFakeAmo } from "./fake-amo";

const key = { emitter: "user:1:abc", secret: "s3cr3t-do-not-leak" };
const dirs: string[] = [];
const fakes: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function xpiOf(guid: string, version: string): Promise<{ xpi: string; output: string }> {
  const d = mkdtempSync(join(tmpdir(), "webaios-amo-test-"));
  dirs.push(d);
  mkdirSync(join(d, "copie"));
  writeFileSync(join(d, "copie", "manifest.json"), JSON.stringify({ manifest_version: 2, name: "t", version, browser_specific_settings: { gecko: { id: guid } } }));
  const xpi = join(d, "t.xpi");
  await zipper(join(d, "copie"), xpi);
  return { xpi, output: join(d, "signe.xpi") };
}

const fake = async (o?: Parameters<typeof startFakeAmo>[0]) => {
  const f = await startFakeAmo(o);
  fakes.push(f);
  return f;
};

describe("AMO client", () => {
  it("signs a new id then a new version; the JWT carries the issuer", async () => {
    const amo = await fake();
    const a = await xpiOf("t@agent.webaios", "1.0.0.1");
    await sign({ ...a, guid: "t@agent.webaios", version: "1.0.0.1", key: key, base: amo.url, stepMs: 10 });
    const b = await xpiOf("t@agent.webaios", "1.0.0.2");
    await sign({ ...b, guid: "t@agent.webaios", version: "1.0.0.2", key: key, base: amo.url, stepMs: 10 });
    expect(amo.sends.map((e) => [e.method, e.version])).toEqual([["PUT", "1.0.0.1"], ["POST", "1.0.0.2"]]);
    for (const e of amo.sends) {
      expect(e.auth.startsWith("JWT ")).toBe(true);
      const [, body] = e.auth.slice(4).split(".");
      const token = JSON.parse(Buffer.from(body!, "base64url").toString());
      expect(token.iss).toBe(key.emitter);
      expect(token.exp - token.iat).toBeLessThanOrEqual(300);
    }
    expect(existsSync(a.output) && existsSync(b.output)).toBe(true);
  });

  it("an AMO refusal comes back as is; a stall times out; a 500 is a network error", async () => {
    const error = async (o: Parameters<typeof startFakeAmo>[0], extra: { delay?: number } = {}) => {
      const amo = await fake(o);
      const a = await xpiOf("t@agent.webaios", "1.0.0.1");
      const e = await sign({ ...a, guid: "t@agent.webaios", version: "1.0.0.1", key: key, base: amo.url, stepMs: 10, ...extra }).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(SignatureError);
      expect(e.message).not.toContain(key.secret);
      return e.message;
    };
    expect(await error({ denial: "Invalid manifest" })).toBe(deniedSignature("Invalid manifest"));
    expect(await error({ delayMs: 5000 }, { delay: 200 })).toBe(SLOW_SIGNATURE);
    expect(await error({ pollError: 403 }, { delay: 300 })).toBe(signatureImpossible("HTTP 403"));
    expect(await error({ httpError: 500 })).toBe(signatureImpossible("HTTP 500"));
  });

  it("a version AMO rejects after validation is refused at once, with AMO's text", async () => {
    const amo = await fake({ fileStatus: "disabled" });
    const a = await xpiOf("t@agent.webaios", "1.0.0.1");
    const start = Date.now();
    const e = await sign({ ...a, guid: "t@agent.webaios", version: "1.0.0.1", key: key, base: amo.url, stepMs: 10, delay: 5000 }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(SignatureError);
    expect(e.message.startsWith(deniedSignature(""))).toBe(true);
    expect(e.message).toContain("disabled");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("keychain: a `security` that hangs counts as keys absent, its output never shown", async () => {
    const d = mkdtempSync(join(tmpdir(), "webaios-amo-test-"));
    dirs.push(d);
    const slow = join(d, "security");
    writeFileSync(slow, "#!/bin/sh\necho 'keychain: \"acct\"<blob>=\"user:1:abc\"'\necho s3cr3t-do-not-leak\nexec sleep 30\n", { mode: 0o755 });
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a));
    const warn = vi.spyOn(console, "warn").mockImplementation((...a) => void errors.push(a));
    const start = Date.now();
    expect(await readAmoKey({}, { command: slow, delay: 200 })).toBeNull();
    expect(Date.now() - start).toBeLessThan(5000);
    spy.mockRestore();
    warn.mockRestore();
    expect(errors).toEqual([]);
  });

  it("keys: test env, absent", async () => {
    expect(await readAmoKey({ WEBAIOS_TEST_AMO_URL: "x", WEBAIOS_TEST_AMO_KEYS: "e:s" })).toEqual({ emitter: "e", secret: "s" });
    expect(await readAmoKey({ WEBAIOS_TEST_AMO_URL: "x", WEBAIOS_TEST_AMO_KEYS: "user:1:abc:s" })).toEqual({ emitter: "user:1:abc", secret: "s" });
    expect(await readAmoKey({ WEBAIOS_TEST_AMO_URL: "x" })).toBeNull();
  });

  // Real AMO, under the owner's account: a real guarded copy of an agent extension, version 1 (new add-on) then 2 (existing one).
  it.skipIf(process.env.WEBAIOS_AMO !== "1")("real AMO: signs a guarded agent copy, then a second version", { timeout: 40 * 60_000 }, async () => {
    const k = await readAmoKey({});
    if (!k) throw new Error("AMO keys absent from the keychain");
    const d = mkdtempSync(join(tmpdir(), "webaios-amo-real-"));
    dirs.push(d);
    const folder = `essai-${Date.now()}`;
    const source = join(d, folder);
    mkdirSync(source);
    writeFileSync(join(source, "content.js"), 'document.title += " ";');
    const signVersion = async (n: number, background: string) => {
      writeFileSync(join(source, "fond.js"), background);
      writeFileSync(
        join(source, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "WebAiOs essai",
          version: "1.0.0",
          background: { service_worker: "fond.js" },
          permissions: ["storage"],
          host_permissions: ["https://example.com/*"],
          content_scripts: [{ matches: ["https://example.com/*"], js: ["content.js"] }],
        }),
      );
      const staging = join(d, `copie-${n}`);
      const r = await prepareCopy({ source, target: staging, keptFolder: DEFAULT_GUARDS });
      expect(r.analysis.denial).toEqual([]);
      const raw = JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8"));
      expect(firefoxDenial(raw, readdirSync(staging, { recursive: true }) as string[])).toEqual([]);
      const f = /^importScripts\("webaios-garde-fond\.js", ("(?:[^"\\]|\\.)*")\);$/m.exec(readFileSync(join(staging, "webaios-fond.js"), "utf8"));
      const manifest = firefoxManifest(raw, folder, n, f ? (JSON.parse(f[1]!) as string) : undefined);
      writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
      const xpi = join(d, `${n}.xpi`);
      const output = join(d, `${n}.signe.xpi`);
      await zipper(staging, xpi);
      const t = Date.now();
      await sign({ xpi, output: output, guid: addonIdOf(folder), version: String(manifest.version), key: k, base: AMO_URL });
      console.log(`version ${manifest.version} signed in ${Math.round((Date.now() - t) / 1000)} s`);
      const { stdout } = await promisify(execFile)("unzip", ["-l", output]);
      expect(stdout).toContain("META-INF/cose.sig");
    };
    await signVersion(1, 'chrome.runtime.onInstalled.addListener(() => console.log("v1"));');
    await signVersion(2, 'chrome.runtime.onInstalled.addListener(() => console.log("v2"));');
  });
});
