import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { AMO_URL, ErreurSignature, SIGNATURE_LENTE, lireCleAmo, signatureImpossible, signatureRefusee, signer } from "../noyau/extensions/amo";
import { zipper } from "../noyau/extensions/copie-firefox";
import { startFakeAmo } from "./fake-amo";

const cle = { emetteur: "user:1:abc", secret: "s3cr3t-do-not-leak" };
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
    await signer({ ...a, guid: "t@agent.webaios", version: "1.0.0.1", cle, base: amo.url, pasMs: 10 });
    const b = await xpiDe("t@agent.webaios", "1.0.0.2");
    await signer({ ...b, guid: "t@agent.webaios", version: "1.0.0.2", cle, base: amo.url, pasMs: 10 });
    expect(amo.envois.map((e) => [e.methode, e.version])).toEqual([["PUT", "1.0.0.1"], ["POST", "1.0.0.2"]]);
    for (const e of amo.envois) {
      expect(e.auth.startsWith("JWT ")).toBe(true);
      const [, corps] = e.auth.slice(4).split(".");
      const jeton = JSON.parse(Buffer.from(corps!, "base64url").toString());
      expect(jeton.iss).toBe(cle.emetteur);
      expect(jeton.exp - jeton.iat).toBeLessThanOrEqual(300);
    }
    expect(existsSync(a.sortie) && existsSync(b.sortie)).toBe(true);
  });

  it("an AMO refusal comes back as is; a stall times out; a 500 is a network error", async () => {
    const erreur = async (o: Parameters<typeof startFakeAmo>[0], extra: { delai?: number } = {}) => {
      const amo = await fake(o);
      const a = await xpiDe("t@agent.webaios", "1.0.0.1");
      const e = await signer({ ...a, guid: "t@agent.webaios", version: "1.0.0.1", cle, base: amo.url, pasMs: 10, ...extra }).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(ErreurSignature);
      expect(e.message).not.toContain(cle.secret);
      return e.message;
    };
    expect(await erreur({ refus: "Invalid manifest" })).toBe(signatureRefusee("Invalid manifest"));
    expect(await erreur({ delaiMs: 5000 }, { delai: 200 })).toBe(SIGNATURE_LENTE);
    expect(await erreur({ erreurSondage: 403 }, { delai: 300 })).toBe(signatureImpossible("HTTP 403"));
    expect(await erreur({ erreurHttp: 500 })).toBe(signatureImpossible("HTTP 500"));
  });

  it("keys: test env, absent", async () => {
    expect(await lireCleAmo({ WEBAIOS_TEST_AMO_URL: "x", WEBAIOS_TEST_AMO_CLES: "e:s" })).toEqual({ emetteur: "e", secret: "s" });
    expect(await lireCleAmo({ WEBAIOS_TEST_AMO_URL: "x", WEBAIOS_TEST_AMO_CLES: "user:1:abc:s" })).toEqual({ emetteur: "user:1:abc", secret: "s" });
    expect(await lireCleAmo({ WEBAIOS_TEST_AMO_URL: "x" })).toBeNull();
  });

  it.skipIf(process.env.WEBAIOS_AMO !== "1")("real AMO: signs a minimal agent extension", { timeout: 20 * 60_000 }, async () => {
    const k = await lireCleAmo({});
    if (!k) throw new Error("AMO keys absent from the keychain");
    const guid = `essai-${Date.now()}@agent.webaios`;
    const a = await xpiDe(guid, "1.0.0.1");
    await signer({ ...a, guid, version: "1.0.0.1", cle: k, base: AMO_URL });
    const { stdout } = await promisify(execFile)("unzip", ["-l", a.sortie]);
    expect(stdout).toContain("META-INF/cose.sig");
  });
});
