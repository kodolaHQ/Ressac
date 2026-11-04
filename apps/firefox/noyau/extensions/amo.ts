import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const AMO_URL = "https://addons.mozilla.org";
/** 3 x the slowest signing measured (298 s, plan 25 spike): AMO signs in 2.5 to 5 minutes. */
export const DELAI_SIGNATURE_MS = 900_000;

export const CLES_ABSENTES = "Clés AMO absentes : ajoute-les au trousseau macOS (service « webaios-amo »). Rien n'est parti chez Mozilla.";
export const signatureRefusee = (m: string) => "Signature refusée par addons.mozilla.org : " + m.slice(0, 2000);
export const SIGNATURE_LENTE = "Signature trop longue : addons.mozilla.org n'a pas rendu le module à temps. Réessaie recharger_extension.";
export const signatureImpossible = (m: string) => "Signature impossible (réseau ou addons.mozilla.org) : " + m;
export const VERSION_QUATRE = "version : trois nombres au plus (WebAiOs ajoute le quatrième)";
export const GECKO_ID = "browser_specific_settings.gecko.id refusé : WebAiOs pose l'identifiant";

export interface CleAmo {
  emetteur: string;
  secret: string;
}

/** Test: WEBAIOS_TEST_AMO_URL set → WEBAIOS_TEST_AMO_CLES ("emetteur:secret") or null; else the keychain (service webaios-amo), null when absent. */
export async function lireCleAmo(env: NodeJS.ProcessEnv = process.env): Promise<CleAmo | null> {
  if (env.WEBAIOS_TEST_AMO_URL) {
    const cles = env.WEBAIOS_TEST_AMO_CLES;
    // The issuer itself holds colons (user:<id>:<hash>): the secret is what follows the last one.
    const i = cles?.lastIndexOf(":") ?? -1;
    return cles && i > 0 && i < cles.length - 1 ? { emetteur: cles.slice(0, i), secret: cles.slice(i + 1) } : null;
  }
  try {
    const [{ stdout: attrs }, { stdout: secret }] = await Promise.all([
      run("security", ["find-generic-password", "-s", "webaios-amo"]),
      run("security", ["find-generic-password", "-s", "webaios-amo", "-w"]),
    ]);
    const emetteur = /"acct"<blob>="([^"]*)"/.exec(attrs)?.[1];
    return emetteur && secret.trim() ? { emetteur, secret: secret.trim() } : null;
  } catch {
    return null;
  }
}

/** A fresh HS256 JWT, valid 60 s. Never logged. */
function jeton(k: CleAmo): string {
  const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const tete = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const corps = b64(JSON.stringify({ iss: k.emetteur, jti: randomUUID(), iat, exp: iat + 60 }));
  return `${tete}.${corps}.${b64(createHmac("sha256", k.secret).update(`${tete}.${corps}`).digest())}`;
}

export class ErreurSignature extends Error {}

/**
 * The `web-ext sign` v5 flow: upload (unlisted), wait for validation, create the add-on (PUT, unknown guid) or a
 * version (POST), wait for the signed file, download it to `sortie`.
 * `delai` and `pasMs` (total wait, polling step) are only there for tests.
 */
export async function signer(o: {
  xpi: string;
  guid: string;
  version: string;
  cle: CleAmo;
  base: string;
  signal?: AbortSignal;
  sortie: string;
  delai?: number;
  pasMs?: number;
}): Promise<void> {
  const api = `${o.base}/api/v5`;
  const fin = Date.now() + (o.delai ?? DELAI_SIGNATURE_MS);
  const pas = o.pasMs ?? 2000;
  const addon = `/addons/addon/${encodeURIComponent(o.guid)}/`;

  async function amo(methode: string, chemin: string, corps?: FormData | object): Promise<{ status: number; body: any }> {
    let res: Response;
    try {
      res = await fetch(chemin.startsWith("http") ? chemin : api + chemin, {
        method: methode,
        headers: { Authorization: `JWT ${jeton(o.cle)}`, ...(corps && !(corps instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
        body: corps instanceof FormData ? corps : corps ? JSON.stringify(corps) : undefined,
        signal: o.signal,
      });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      throw new ErreurSignature(signatureImpossible((e as Error).message));
    }
    if (res.status >= 500) throw new ErreurSignature(signatureImpossible(`HTTP ${res.status}`));
    const texte = await res.text();
    let body: unknown = texte;
    try {
      body = JSON.parse(texte);
    } catch {}
    return { status: res.status, body };
  }
  const refus = (r: { status: number; body: any }) => new ErreurSignature(signatureRefusee(typeof r.body === "string" ? r.body : JSON.stringify(r.body)));
  const attendre = async () => {
    if (Date.now() + pas > fin) throw new ErreurSignature(SIGNATURE_LENTE);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, pas);
      o.signal?.addEventListener("abort", () => (clearTimeout(t), reject(o.signal!.reason)), { once: true });
    });
  };

  const form = new FormData();
  form.append("upload", new Blob([await readFile(o.xpi)]), path.basename(o.xpi));
  form.append("channel", "unlisted");
  const envoi = await amo("POST", "/addons/upload/", form);
  if (envoi.status >= 300) throw refus(envoi);
  let u = envoi.body;
  while (!u.processed) {
    await attendre();
    u = (await amo("GET", `/addons/upload/${u.uuid}/`)).body;
  }
  if (!u.valid) {
    const messages: { type?: string; message?: string }[] = u.validation?.messages ?? [];
    const erreurs = messages.filter((m) => m.type === "error");
    throw new ErreurSignature(signatureRefusee((erreurs.length ? erreurs : messages).map((m) => m.message).join(" ; ")));
  }

  const existe = await amo("GET", addon);
  if (existe.status !== 404 && existe.status >= 300) throw refus(existe);
  const cree = existe.status === 404 ? await amo("PUT", addon, { version: { upload: u.uuid } }) : await amo("POST", `${addon}versions/`, { upload: u.uuid });
  if (cree.status >= 300) throw refus(cree);

  let v: any;
  for (;;) {
    v = (await amo("GET", `${addon}versions/v${o.version}/`)).body;
    if (v?.file?.status === "public") break;
    await attendre();
  }
  const dl = await fetch(v.file.url, { headers: { Authorization: `JWT ${jeton(o.cle)}` }, signal: o.signal }).catch((e) => {
    if (o.signal?.aborted) throw e;
    throw new ErreurSignature(signatureImpossible((e as Error).message));
  });
  if (!dl.ok) throw new ErreurSignature(signatureImpossible(`HTTP ${dl.status}`));
  await mkdir(path.dirname(o.sortie), { recursive: true });
  await writeFile(o.sortie, Buffer.from(await dl.arrayBuffer()));
}
