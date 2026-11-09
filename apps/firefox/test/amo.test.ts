import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AMO_URL, SignatureError, SLOW_SIGNATURE, readAmoKey, signatureImpossible, deniedSignature, signer } from "../host/extensions/amo";
import { addonIdDe, firefoxManifest, firefoxDenial, zipper } from "../host/extensions/firefox-copy";
import { DEFAULT_GUARDS, prepareCopy } from "../../../packages/kernel/src/index.ts";
import { startFakeAmo } from "./fake-amo";

const key = { emetteur: "user:1:abc", secret: "s3cr3t-do-not-leak" };
const dirs: string[] = [];
const fakes: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function xpiDe(guid: string, version: string): Promise<{ xpi: string; sortie: string }> {
  const d = mkdtempSync(join(tmpdir(), "webaios-amo-test-"));
  dirs.push(d);
  mkdirSync(join(d, "copie"));
  writeFileSync(join(d, "copie", "manifest.json"), JSON.stringify({ manifest_version: 2, name: "t", version, browser_specific_settings: { gecko: { id: guid } } }));
  const xpi = join(d, "t.xpi");
  await zipper(join(d, "copie"), xpi);
  return { xpi, sortie: join(d, "signe.xpi") };
}

const fake = async (o?: Parameters<typeof startFakeAmo>[0]) => {
  const f = await startFakeAmo(o);
  fakes.push(f);
  return f;
};

describe("AMO client", () => {
  it("signs a new id then a new version; the JWT carries the issuer", async () => {
    const amo = await fake();
    const a = await xpiDe("t@agent.webaios", "1.0.0.1");
    await signer({ ...a, guid: "t@agent.webaios", version: "1.0.0.1", cle: key, base: amo.url, pasMs: 10 });
    const b = await xpiDe("t@agent.webaios", "1.0.0.2");
    await signer({ ...b, guid: "t@agent.webaios", version: "1.0.0.2", cle: key, base: amo.url, pasMs: 10 });
    expect(amo.envois.map((e) => [e.methode, e.version])).toEqual([["PUT", "1.0.0.1"], ["POST", "1.0.0.2"]]);
    for (const e of amo.envois) {
      expect(e.auth.startsWith("JWT ")).toBe(true);
      const [, corps] = e.auth.slice(4).split(".");
      const token = JSON.parse(Buffer.from(corps!, "base64url").toString());
      expect(token.iss).toBe(key.emetteur);
      expect(token.exp - token.iat).toBeLessThanOrEqual(300);
    }
    expect(existsSync(a.sortie) && existsSync(b.sortie)).toBe(true);
  });

  it("an AMO refusal comes back as is; a stall times out; a 500 is a network error", async () => {
    const error = async (o: Parameters<typeof startFakeAmo>[0], extra: { delai?: number } = {}) => {
      const amo = await fake(o);
      const a = await xpiDe("t@agent.webaios", "1.0.0.1");
      const e = await signer({ ...a, guid: "t@agent.webaios", version: "1.0.0.1", cle: key, base: amo.url, pasMs: 10, ...extra }).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(SignatureError);
      expect(e.message).not.toContain(key.secret);
      return e.message;
    };
    expect(await error({ refus: "Invalid manifest" })).toBe(deniedSignature("Invalid manifest"));
    expect(await error({ delaiMs: 5000 }, { delai: 200 })).toBe(SLOW_SIGNATURE);
    expect(await error({ erreurSondage: 403 }, { delai: 300 })).toBe(signatureImpossible("HTTP 403"));
    expect(await error({ erreurHttp: 500 })).toBe(signatureImpossible("HTTP 500"));
  });

  it("a version AMO rejects after validation is refused at once, with AMO's text", async () => {
    const amo = await fake({ statutFichier: "disabled" });
    const a = await xpiDe("t@agent.webaios", "1.0.0.1");
    const debut = Date.now();
    const e = await signer({ ...a, guid: "t@agent.webaios", version: "1.0.0.1", cle: key, base: amo.url, pasMs: 10, delai: 5000 }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(SignatureError);
    expect(e.message.startsWith(deniedSignature(""))).toBe(true);
    expect(e.message).toContain("disabled");
    expect(Date.now() - debut).toBeLessThan(2000);
  });

  it("keychain: a `security` that hangs counts as keys absent, its output never shown", async () => {
    const d = mkdtempSync(join(tmpdir(), "webaios-amo-test-"));
    dirs.push(d);
    const lent = join(d, "security");
    writeFileSync(lent, "#!/bin/sh\necho 'keychain: \"acct\"<blob>=\"user:1:abc\"'\necho s3cr3t-do-not-leak\nexec sleep 30\n", { mode: 0o755 });
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a));
    const warn = vi.spyOn(console, "warn").mockImplementation((...a) => void errors.push(a));
    const debut = Date.now();
    expect(await readAmoKey({}, { commande: lent, delai: 200 })).toBeNull();
    expect(Date.now() - debut).toBeLessThan(5000);
    spy.mockRestore();
    warn.mockRestore();
    expect(errors).toEqual([]);
  });

  it("keys: test env, absent", async () => {
    expect(await readAmoKey({ WEBAIOS_TEST_AMO_URL: "x", WEBAIOS_TEST_AMO_CLES: "e:s" })).toEqual({ emetteur: "e", secret: "s" });
    expect(await readAmoKey({ WEBAIOS_TEST_AMO_URL: "x", WEBAIOS_TEST_AMO_CLES: "user:1:abc:s" })).toEqual({ emetteur: "user:1:abc", secret: "s" });
    expect(await readAmoKey({ WEBAIOS_TEST_AMO_URL: "x" })).toBeNull();
  });

  // Real AMO, under the owner's account: a real guarded copy of an agent extension, version 1 (new add-on) then 2 (existing one).
  it.skipIf(process.env.WEBAIOS_AMO !== "1")("real AMO: signs a guarded agent copy, then a second version", { timeout: 40 * 60_000 }, async () => {
    const k = await readAmoKey({});
    if (!k) throw new Error("AMO keys absent from the keychain");
    const d = mkdtempSync(join(tmpdir(), "webaios-amo-real-"));
    dirs.push(d);
    const dossier = `essai-${Date.now()}`;
    const source = join(d, dossier);
    mkdirSync(source);
    writeFileSync(join(source, "content.js"), 'document.title += " ";');
    const signerVersion = async (n: number, fond: string) => {
      writeFileSync(join(source, "fond.js"), fond);
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
      const r = await prepareCopy({ source, cible: staging, dossierGardes: DEFAULT_GUARDS });
      expect(r.analyse.refus).toEqual([]);
      const brut = JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8"));
      expect(firefoxDenial(brut, readdirSync(staging, { recursive: true }) as string[])).toEqual([]);
      const f = /^importScripts\("webaios-garde-fond\.js", ("(?:[^"\\]|\\.)*")\);$/m.exec(readFileSync(join(staging, "webaios-fond.js"), "utf8"));
      const manifest = firefoxManifest(brut, dossier, n, f ? (JSON.parse(f[1]!) as string) : undefined);
      writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
      const xpi = join(d, `${n}.xpi`);
      const sortie = join(d, `${n}.signe.xpi`);
      await zipper(staging, xpi);
      const t = Date.now();
      await signer({ xpi, sortie, guid: addonIdDe(dossier), version: String(manifest.version), cle: k, base: AMO_URL });
      console.log(`version ${manifest.version} signed in ${Math.round((Date.now() - t) / 1000)} s`);
      const { stdout } = await promisify(execFile)("unzip", ["-l", sortie]);
      expect(stdout).toContain("META-INF/cose.sig");
    };
    await signerVersion(1, 'chrome.runtime.onInstalled.addListener(() => console.log("v1"));');
    await signerVersion(2, 'chrome.runtime.onInstalled.addListener(() => console.log("v2"));');
  });
});
