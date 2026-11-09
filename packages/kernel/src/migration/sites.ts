import { createHash } from "node:crypto";
import { join } from "node:path";
import { SiteRights, siteExtensionsHash } from "../sites/grants.js";
import { DeclarationSite } from "../sites/schemas.js";
import { folders, kind, readNoFollow, renameJson, rewriteJson, schemaCheck, type Check, type Ctx, type Rule } from "./json.js";

const recordsOf = (check: Check): Check => (v) => Object.values(v as Record<string, unknown>).map(check).find((e) => e !== null) ?? null;

/** `sites.json` and `apps.json`: `{ <id>: { frame, lastLaunch, favicon } }`. */
const RECORDS_RULE: Rule = { records: { "": null } };
const SITE_MEMORY_RULE: Rule = { records: { values: null, positions: null }, opaque: ["values.*.value"] };

export async function migrateSites(ctx: Ctx): Promise<void> {
  const d = ctx.dataDir;
  const w = join(ctx.workspace, "sites");
  for (const s of await folders(w)) {
    await rewriteJson(ctx, join(w, s, "site.json"), join(w, s, "site.json"), {}, schemaCheck(DeclarationSite));
  }
  await rewriteJson(ctx, join(d, "sites-accords.json"), join(d, "site-grants.json"), RECORDS_RULE, recordsOf(schemaCheck(SiteRights)));
  await rewriteJson(ctx, join(d, "sites.json"), join(d, "sites.json"), RECORDS_RULE, null);
  await rewriteJson(ctx, join(d, "applications.json"), join(d, "apps.json"), RECORDS_RULE, null);
  for (const s of await folders(join(d, "sites"))) {
    await rewriteJson(ctx, join(d, "sites", s, "adresse.json"), join(d, "sites", s, "url.json"), {}, null);
    await rewriteJson(ctx, join(d, "sites", s, "memoire.json"), join(d, "sites", s, "memory.json"), SITE_MEMORY_RULE, null);
  }
}

/**
 * The migrated declaration of a site app and the hash its domains had under the French keys, for the Store
 * extensions' `siteApps`. Null: no site, or an invalid one (the entry is then left as is).
 */
export async function siteHashes(ctx: Ctx, id: string): Promise<{ old: string; fresh: string } | null> {
  const file = join(ctx.workspace, "sites", id, "site.json");
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(id) || (await kind(file)) !== "file") return null;
  let raw: unknown;
  try {
    raw = JSON.parse((await readNoFollow(file)).toString());
  } catch {
    return null;
  }
  const r = DeclarationSite.safeParse(renameJson(raw, {}));
  if (!r.success) return null;
  const canon = (l: string[]) => [...new Set(l.map((x) => x.toLowerCase()))].sort();
  const old = createHash("sha256").update(JSON.stringify({ domaines: canon(r.data.domains), connexion: canon(r.data.login) })).digest("hex");
  return { old, fresh: siteExtensionsHash(r.data) };
}
