// Prints a tester's download link for the latest DMG: an R2 presigned URL (S3 signature v4) that expires.
// node scripts/invite-link.mjs [days, 1 to 7, default 7]. Needs RESSAC_UPDATE_KEY and an R2 API token with read access
// (Cloudflare › R2 › Manage API tokens): RESSAC_R2_ACCOUNT_ID, RESSAC_R2_ACCESS_KEY_ID, RESSAC_R2_SECRET_ACCESS_KEY.
import { createHash, createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

const hmac = (key, text) => createHmac("sha256", key).update(text).digest();
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
// RFC 3986 encoding, as S3 wants it (encodeURIComponent leaves !'()* alone).
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A presigned GET URL. `date` is the signing time, e.g. 20261114T120000Z; `expires` in seconds (S3 allows 7 days). */
export function presign({ host, path, region, accessKeyId, secretAccessKey, date, expires }) {
  const day = date.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const query = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKeyId}/${scope}`],
    ["X-Amz-Date", date],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", "host"],
  ]
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .join("&");
  const uri = path.split("/").map(encode).join("/");
  const request = ["GET", uri, query, `host:${host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(request)].join("\n");
  let key = hmac(`AWS4${secretAccessKey}`, day);
  for (const part of [region, "s3", "aws4_request"]) key = hmac(key, part);
  return `https://${host}${uri}?${query}&X-Amz-Signature=${hmac(key, toSign).toString("hex")}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is empty (see the top of scripts/invite-link.mjs)`);
    return v;
  };
  const days = Number(process.argv[2] ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 7) throw new Error("days: 1 to 7 (the longest S3 allows)");
  const updateKey = env("RESSAC_UPDATE_KEY");
  if (!/^[a-z0-9]{24,64}$/.test(updateKey)) throw new Error("RESSAC_UPDATE_KEY must be 24 to 64 lowercase letters or digits");
  const url = presign({
    host: `${env("RESSAC_R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    path: `/${process.env.RESSAC_R2_BUCKET || "ressac-update"}/updates/${updateKey}/Ressac.dmg`,
    region: "auto",
    accessKeyId: env("RESSAC_R2_ACCESS_KEY_ID"),
    secretAccessKey: env("RESSAC_R2_SECRET_ACCESS_KEY"),
    date: new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""),
    expires: days * 86400,
  });
  process.stdout.write(`${url}\n`);
}
