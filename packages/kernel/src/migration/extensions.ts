import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { hashOf, readFolder } from "../extensions/copy.js";
import { readExtensionsState } from "../extensions/registry.js";
import { filesIn, folders, kind, parse, readNoFollow, rel, renameJson, rewriteJson, stringify, type Ctx, type Rule } from "./json.js";
import { VALUES } from "./names.js";
import { siteHashes } from "./sites.js";

const PROFILE = { defaut: "default" };

const STATE_RULE: Rule = {
  records: { extensions: null, "extensions.*.seenVersions": PROFILE, "extensions.*.siteApps": null },
  values: { "extensions.*.profiles.*": PROFILE, "extensions.*.hiddenConsole.*": PROFILE, "extensions.*.disabled.reason": VALUES },
};

type Entry = { siteApps?: Record<string, string> };

/** A signed hash no source has: the host's startup signs the extension again (as after a change of its source). */
export const RESIGN = "re-sign";

/** The old guards: their files' names (also readable in a .xpi's zip directory) or their API in a copy. */
const OLD_GUARD = /webaios-garde-|__webaios\.(urlPermise|hotePermis|estOnglet)(?![A-Za-z0-9_])/;

/** The kept signed .xpi or its copy holds the old guards (they call names the actor no longer answers). */
async function oldGuards(folder: string, id: string): Promise<boolean> {
  const files = [join(folder, "signed", `${id}.xpi`), ...(await filesIn(join(folder, "copies", id))).map((n) => join(folder, "copies", id, n))];
  for (const f of files) {
    if (OLD_GUARD.test(f.slice(folder.length))) return true;
    const b = await readNoFollow(f).catch(() => null);
    if (b && OLD_GUARD.test(b.toString("latin1"))) return true;
  }
  return false;
}

/**
 * `extensions/state.json`, the agent extensions' `webaios.json` (`network`) and their `signed/<id>.json`. A stored
 * hash (site app domains, signed source) is recomputed only if it matched the old content: a stale one stays
 * stale, so the usual check still asks again. A signed .xpi holding the old guards is marked to sign again instead.
 */
export async function migrateExtensions(ctx: Ctx): Promise<void> {
  const folder = join(ctx.dataDir, "extensions");
  const sites = new Map<string, { old: string; fresh: string }>();
  for (const id of await folders(join(ctx.workspace, "sites"))) {
    const h = await siteHashes(ctx, id);
    if (h) sites.set(id, h);
  }
  await rewriteJson(
    ctx,
    join(folder, "etat.json"),
    join(folder, "state.json"),
    STATE_RULE,
    async (v) => {
      const raw = Object.keys((v as { extensions?: object }).extensions ?? {}).length;
      return Object.keys((await readExtensionsState(folder)).extensions).length === raw ? null : "entrées ignorées à la lecture";
    },
    (v) => {
      for (const e of Object.values((v as { extensions?: Record<string, Entry> }).extensions ?? {})) {
        for (const [id, h] of Object.entries(e.siteApps ?? {})) {
          const s = sites.get(id);
          if (s && s.old === h) e.siteApps![id] = s.fresh;
        }
      }
      return v;
    },
  );

  const signed = join(folder, "signed");
  const sources = join(ctx.workspace, "extensions");
  for (const id of await folders(sources)) {
    const source = join(sources, id);
    const webaios = join(source, "webaios.json");
    let restamp: { old: string; fresh: string } | null = null;
    if ((await kind(webaios)) === "file") {
      const { files, denial } = await readFolder(source);
      const text = files.get("webaios.json");
      if (denial.length === 0 && text) {
        try {
          const migrated = Buffer.from(stringify(renameJson(parse(text), {}), text));
          restamp = { old: hashOf(files), fresh: hashOf(new Map(files).set("webaios.json", migrated)) };
        } catch {
          // unparsable webaios.json: left by its own rewrite below, and listed
        }
      }
    }
    const resign = (await kind(join(signed, `${id}.json`))) === "file" && (await oldGuards(folder, id));
    if (resign) ctx.resign.push(rel(ctx, source));
    // The signed record first: once webaios.json is rewritten, the old hash can no longer be checked.
    await rewriteJson(ctx, join(signed, `${id}.json`), join(signed, `${id}.json`), {}, (v) => (typeof (v as { hash?: unknown }).hash === "string" ? null : "hash absent"), (v) => {
      const s = v as { hash?: unknown };
      if (resign) s.hash = RESIGN;
      else if (restamp && s.hash === restamp.old) s.hash = restamp.fresh;
      return s;
    });
    await rewriteJson(ctx, webaios, webaios, {}, null);
  }

  // Leftovers of an interrupted copy or signing, under their old suffixes (the start-up cleanup knows only the new ones).
  for (const [sub, pattern] of [
    ["copies", /\.attente$/],
    ["signed", /\.(attente|envoi)\.xpi$/],
  ] as const) {
    const names = (await kind(join(folder, sub))) === "dir" ? await readdir(join(folder, sub)) : [];
    for (const n of names) if (pattern.test(n)) await rm(join(folder, sub, n), { recursive: true, force: true });
  }
}
