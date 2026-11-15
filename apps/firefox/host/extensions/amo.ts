import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
// A cycle (keychain.ts reads keys through readAmoKey): both only call each other inside functions.
import { AMO_SERVICE } from "../keychain";
import { hostSay } from "../locale.ts";

const run = promisify(execFile);

export const AMO_URL = "https://addons.mozilla.org";
/** 3 x the slowest signing measured (298 s, plan 25 spike): AMO signs in 2.5 to 5 minutes. */
export const SIGNATURE_DELAY_MS = 900_000;

export const KEYS_ABSENT = () => hostSay("host-amo-keys-absent");
export const deniedSignature = (m: string) => "Signature refusée par addons.mozilla.org : " + m.slice(0, 2000);
export const SLOW_SIGNATURE = "Signature trop longue : addons.mozilla.org n'a pas rendu le module à temps. Réessayez reload_extension.";
export const signatureImpossible = (m: string) => "Signature impossible (réseau ou addons.mozilla.org) : " + m;
export const VERSION_FOUR = "version : trois nombres au plus (Ressac ajoute le quatrième)";
export const GECKO_ID = "browser_specific_settings.gecko.id refusé : Ressac pose l'identifiant";

export interface AmoKey {
  emitter: string;
  secret: string;
}

/** How long a keychain read may take (a locked keychain waits on a macOS prompt): past it, the keys count as absent. */
export const KEYCHAIN_DELAY_MS = 10_000;

/**
 * Test: RESSAC_TEST_AMO_URL set → RESSAC_TEST_AMO_KEYS ("emetteur:secret") or null; else RESSAC_TEST_KEYCHAIN's ".amo" file; else the keychain (service ressac-amo),
 * null when absent or too slow. `command` and `delai` are only there for tests.
 */
export async function readAmoKey(env: NodeJS.ProcessEnv = process.env, o: { command?: string; delay?: number } = {}): Promise<AmoKey | null> {
  // The issuer itself holds colons (user:<id>:<hash>): the secret is what follows the last one.
  const split = (keys?: string): AmoKey | null => {
    const i = keys?.lastIndexOf(":") ?? -1;
    return keys && i > 0 && i < keys.length - 1 ? { emitter: keys.slice(0, i), secret: keys.slice(i + 1) } : null;
  };
  if (env.RESSAC_TEST_AMO_URL) return split(env.RESSAC_TEST_AMO_KEYS);
  if (env.RESSAC_TEST_KEYCHAIN) return split(await readFile(`${env.RESSAC_TEST_KEYCHAIN}.amo`, "utf8").catch(() => undefined));
  const command = o.command ?? "security";
  try {
    const security = (args: string[]) => run(command, ["find-generic-password", "-s", AMO_SERVICE, ...args], { timeout: o.delay ?? KEYCHAIN_DELAY_MS });
    const [{ stdout: attrs }, { stdout: secret }] = await Promise.all([security([]), security(["-w"])]);
    const issuer = /"acct"<blob>="([^"]*)"/.exec(attrs)?.[1];
    return issuer && secret.trim() ? { emitter: issuer, secret: secret.trim() } : null;
  } catch {
    // Refused, timed out or not found: the error holds the command's output, so it is never logged.
    return null;
  }
}

/** A fresh HS256 JWT, valid 60 s. Never logged. */
function token(k: AmoKey): string {
  const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(JSON.stringify({ iss: k.emitter, jti: randomUUID(), iat, exp: iat + 60 }));
  return `${head}.${payload}.${b64(createHmac("sha256", k.secret).update(`${head}.${payload}`).digest())}`;
}

export class SignatureError extends Error {}

/**
 * The `web-ext sign` v5 flow: upload (unlisted), wait for validation, create the add-on (PUT, unknown guid) or a
 * version (POST), wait for the signed file, download it to `sortie`.
 * `delai` and `pasMs` (total wait, polling step) are only there for tests.
 */
export async function sign(o: {
  xpi: string;
  guid: string;
  version: string;
  key: AmoKey;
  base: string;
  signal?: AbortSignal;
  output: string;
  delay?: number;
  stepMs?: number;
}): Promise<void> {
  const api = `${o.base}/api/v5`;
  const end = Date.now() + (o.delay ?? SIGNATURE_DELAY_MS);
  const step = o.stepMs ?? 2000;
  const addon = `/addons/addon/${encodeURIComponent(o.guid)}/`;

  async function amo(method: string, path: string, payload?: FormData | object): Promise<{ status: number; body: any }> {
    let res: Response;
    try {
      res = await fetch(path.startsWith("http") ? path : api + path, {
        method,
        headers: { Authorization: `JWT ${token(o.key)}`, ...(payload && !(payload instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
        body: payload instanceof FormData ? payload : payload ? JSON.stringify(payload) : undefined,
        signal: o.signal,
      });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      throw new SignatureError(signatureImpossible((e as Error).message));
    }
    if (res.status >= 500) throw new SignatureError(signatureImpossible(`HTTP ${res.status}`));
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body };
  }
  const denial = (r: { status: number; body: any }) => new SignatureError(deniedSignature(typeof r.body === "string" ? r.body : JSON.stringify(r.body)));
  const wait = async () => {
    if (Date.now() + step > end) throw new SignatureError(SLOW_SIGNATURE);
    o.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finished = () => (clearTimeout(t), o.signal?.removeEventListener("abort", cancelled), resolve());
      const cancelled = () => (clearTimeout(t), reject(o.signal!.reason));
      const t = setTimeout(finished, step);
      o.signal?.addEventListener("abort", cancelled, { once: true });
    });
  };

  const form = new FormData();
  form.append("upload", new Blob([await readFile(o.xpi)]), path.basename(o.xpi));
  form.append("channel", "unlisted");
  const sending = await amo("POST", "/addons/upload/", form);
  if (sending.status >= 300) throw denial(sending);
  let u = sending.body;
  while (!u.processed) {
    await wait();
    const r = await amo("GET", `/addons/upload/${u.uuid}/`);
    if (r.status >= 300) throw new SignatureError(signatureImpossible(`HTTP ${r.status}`));
    u = r.body;
  }
  if (!u.valid) {
    const messages: { type?: string; message?: string }[] = u.validation?.messages ?? [];
    const errors = messages.filter((m) => m.type === "error");
    throw new SignatureError(deniedSignature((errors.length ? errors : messages).map((m) => m.message).join(" ; ")));
  }

  const exists = await amo("GET", addon);
  if (exists.status !== 404 && exists.status >= 300) throw denial(exists);
  const created = exists.status === 404 ? await amo("PUT", addon, { version: { upload: u.uuid } }) : await amo("POST", `${addon}versions/`, { upload: u.uuid });
  if (created.status >= 300) throw denial(created);

  let v: any;
  for (;;) {
    const r = await amo("GET", `${addon}versions/v${o.version}/`);
    // A 404 may just mean the version is not visible yet.
    if (r.status >= 300 && r.status !== 404) throw new SignatureError(signatureImpossible(`HTTP ${r.status}`));
    v = r.body;
    if (v?.file?.status === "public") break;
    // Rejected after validation (disabled…): it will never turn public.
    if (v?.file?.status && v.file.status !== "unreviewed") throw denial(r);
    await wait();
  }
  const dl = await fetch(v.file.url, { headers: { Authorization: `JWT ${token(o.key)}` }, signal: o.signal }).catch((e) => {
    if (o.signal?.aborted) throw e;
    throw new SignatureError(signatureImpossible((e as Error).message));
  });
  if (!dl.ok) throw new SignatureError(signatureImpossible(`HTTP ${dl.status}`));
  await mkdir(path.dirname(o.output), { recursive: true });
  await writeFile(o.output, Buffer.from(await dl.arrayBuffer()));
}
