import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A passport entry as chrome/passport/store.ts keeps it (design § 3.2). */
export type PassportEntry = { id: string; field: string; value: Record<string, string>; origins: string[]; variants?: string[] };

const created = "2026-11-23T10:00:00.000Z";

/** `profile`'s passport file, as chrome/passport/store.ts writes it under the `memory` cipher seam (cipher.ts). */
export async function writePassport(profileDir: string, entries: PassportEntry[], profile = "default"): Promise<void> {
  const key = createHash("sha256").update("ressac-passport-dev-key").digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const full = entries.map((e) => ({ variants: [], how: "typed", created, updated: created, ...e }));
  // WebCrypto's AES-GCM output is the ciphertext followed by its tag.
  const body = Buffer.concat([c.update(JSON.stringify({ version: 1, entries: full }), "utf8"), c.final(), c.getAuthTag()]);
  const dir = join(profileDir, "ressac", "passport");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const envelope = { format: "ressac-passport", version: 1, profile, cipher: `${iv.toString("base64")}.${body.toString("base64")}` };
  await writeFile(join(dir, `${profile}.json`), JSON.stringify(envelope), { mode: 0o600 });
}

/** `profile`'s passport entries as the app last wrote them under the `memory` cipher seam. */
export async function readPassport(profileDir: string, profile = "default"): Promise<PassportEntry[]> {
  const envelope = JSON.parse(await readFile(join(profileDir, "ressac", "passport", `${profile}.json`), "utf8"));
  const [iv, body] = String(envelope.cipher).split(".").map((x) => Buffer.from(x, "base64"));
  const d = createDecipheriv("aes-256-gcm", createHash("sha256").update("ressac-passport-dev-key").digest(), iv!);
  d.setAuthTag(body!.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(body!.subarray(0, -16)), d.final()]).toString("utf8")).entries;
}
