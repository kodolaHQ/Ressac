import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeAtomic } from "../workflows/executions.js";
import { localUrl } from "../workflows/access.js";
import { PlanPage } from "../pages/plan.js";
import { validatePlan } from "../pages/validate.js";
import { chainsOf, resolvePage, type RenderedPage } from "../pages/resolve.js";
import { BUILTIN_COMPONENTS } from "../pages/catalog.js";
import type { SeenUrls } from "../mcp/seen.js";

export const ID_RECAP = /^[0-9a-f-]{36}$/;
export const RECAP_UNKNOWN = "Récap introuvable : publie sans id pour en créer un.";
export const RECAP_TOO_BIG = "Récap trop gros (1 Mo au plus).";
const RECAP_MAX_BYTES = 1024 * 1024;
const ALLOWED_MAX = 5000;
export const RECAP_TITLE_MAX = 120;

/** `allowed`: the addresses of the results the agent had read, the only ones the page may link to or load. */
export type RecapFile = { version: 1; id: string; title: string; results: unknown; plan: PlanPage; allowed: string[]; updated: string; shown: string };

const RecapSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(ID_RECAP),
  title: z.string().max(RECAP_TITLE_MAX),
  results: z.unknown(),
  plan: PlanPage,
  allowed: z.array(z.string()).max(ALLOWED_MAX),
  updated: z.string(),
  shown: z.string(),
});

export type RecapPublished = { ok: true; id: string; created: boolean; discarded: string[] } | { ok: false; errors: string[] };

export interface Recaps {
  publish(o: { id?: string; title: string; results: unknown; plan: unknown; seen: SeenUrls }): Promise<RecapPublished>;
  read(id: string): Promise<RecapFile | null>;
  /** `gone`: no file (closed, swept). null: not a recap id, or an unreadable file. Stamps `shown`. */
  page(id: string): Promise<{ title: string; updated: string; page: RenderedPage } | { gone: true } | null>;
  linkAllowed(id: string, url: string): Promise<boolean>;
  imageAllowed(id: string, url: string): Promise<boolean>;
  remove(id: string): Promise<void>;
  /** Recaps neither published nor shown for more than `maxAgeMs`. */
  stale(maxAgeMs: number): Promise<string[]>;
}

/** Same rule as a link opened from an action page: http(s), no credentials, no local address. */
function openable(url: string, httpsOnly: boolean): boolean {
  if (!URL.canParse(url)) return false;
  const u = new URL(url);
  if (u.protocol !== "https:" && (httpsOnly || u.protocol !== "http:")) return false;
  return !u.username && !u.password && !localUrl(u.hostname);
}

/**
 * Recaps the agent publishes, one JSON file per recap in `folder`. Holds no state outside the folder: the kernel
 * publishes with one instance, the host serves pages and erases with its own.
 */
export function createRecaps(o: { folder: string; now?: () => Date }): Recaps {
  const now = () => (o.now ?? (() => new Date()))().toISOString();
  const path = (id: string) => join(o.folder, `${id}.json`);
  const write = (f: RecapFile) => writeAtomic(path(f.id), JSON.stringify(f));

  async function read(id: string): Promise<RecapFile | null> {
    if (!ID_RECAP.test(id)) return null;
    try {
      if ((await stat(path(id))).size > RECAP_MAX_BYTES) return null;
      return RecapSchema.parse(JSON.parse(await readFile(path(id), "utf8"))) satisfies RecapFile;
    } catch {
      return null;
    }
  }

  const allowedIn = async (id: string, url: string, httpsOnly: boolean) => openable(url, httpsOnly) && !!(await read(id))?.allowed.includes(url);

  return {
    read,
    async publish(p) {
      const before = p.id === undefined ? null : await read(p.id);
      if (p.id !== undefined && !before) return { ok: false, errors: [RECAP_UNKNOWN] };
      const v = validatePlan(p.plan, { catalog: BUILTIN_COMPONENTS, results: p.results });
      if (!v.ok) return v;
      // Seen now, or allowed before (a republish keeps what was read for the first version).
      const kept = new Set(before?.allowed);
      const allowed = [...chainsOf(p.results)].filter((s) => kept.has(s) || p.seen.has(s)).slice(0, ALLOWED_MAX);
      const at = now();
      const f: RecapFile = { version: 1, id: before?.id ?? randomUUID(), title: p.title.slice(0, RECAP_TITLE_MAX), results: p.results, plan: v.plan, allowed, updated: at, shown: before?.shown ?? at };
      if (Buffer.byteLength(JSON.stringify(f)) > RECAP_MAX_BYTES) return { ok: false, errors: [RECAP_TOO_BIG] };
      await write(f);
      return { ok: true, id: f.id, created: !before, discarded: v.discarded };
    },
    async page(id) {
      if (!ID_RECAP.test(id)) return null;
      const exists = () => stat(path(id)).then(() => true, () => false);
      const f = await read(id);
      if (!f) return (await exists()) ? null : { gone: true };
      // Removed since the read (its tab closed): the stamp must not bring it back.
      if (!(await exists())) return { gone: true };
      // shortcut: a remove or publish landing between this check and the write is still lost or undone; add a per-id lock if it shows up.
      await write({ ...f, shown: now() });
      return { title: f.title, updated: f.updated, page: resolvePage(f.plan, f.results, { account: false, catalog: BUILTIN_COMPONENTS, fallback: false, allowed: new Set(f.allowed) }) };
    },
    linkAllowed: (id, url) => allowedIn(id, url, false),
    imageAllowed: (id, url) => allowedIn(id, url, true),
    async remove(id) {
      if (ID_RECAP.test(id)) await rm(path(id), { force: true });
    },
    async stale(maxAgeMs) {
      const names = await readdir(o.folder).catch(() => [] as string[]);
      const limit = Date.parse(now()) - maxAgeMs;
      const ids: string[] = [];
      for (const name of names) {
        const f = name.endsWith(".json") ? await read(name.slice(0, -5)) : null;
        // shortcut: an unreadable recap file is never swept; sweep by mtime if such files show up.
        if (f && Math.max(Date.parse(f.updated), Date.parse(f.shown)) < limit) ids.push(f.id);
      }
      return ids;
    },
  };
}
