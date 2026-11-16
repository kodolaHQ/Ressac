import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat, utimes } from "node:fs/promises";
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
const DAY_MS = 86_400_000;
/** A live recap not republished for this long reads as final: the agent stopped without saying so. */
const LIVE_MS = 5 * 60_000;
/** Days the browser ran, as day numbers; never matches ID_RECAP, so it is not a recap. */
const USED_DAYS_FILE = "used-days.json";
const USED_DAYS_MAX = 60;

/**
 * `allowed`: the addresses of the results the agent had read, the only ones the page may link to or load.
 * `live`: the agent is still filling it (absent: final).
 */
export type RecapFile = { version: 1; id: string; title: string; results: unknown; plan: PlanPage; allowed: string[]; updated: string; live?: true };

const RecapSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(ID_RECAP),
  title: z.string().max(RECAP_TITLE_MAX),
  results: z.unknown(),
  plan: PlanPage,
  allowed: z.array(z.string()).max(ALLOWED_MAX),
  updated: z.string(),
  live: z.literal(true).optional(),
});

/** `unread`: web addresses in the results the agent never read, shown without link or photo. */
export type RecapPublished = { ok: true; id: string; created: boolean; discarded: string[]; unread: string[] } | { ok: false; errors: string[] };

export interface Recaps {
  publish(o: { id?: string; title: string; results: unknown; plan: unknown; seen: SeenUrls; live?: boolean }): Promise<RecapPublished>;
  read(id: string): Promise<RecapFile | null>;
  /**
   * `gone`: no file (closed, swept). null: not a recap id, or an unreadable file. Stamps the file's mtime (last shown).
   * `live`: published live less than 5 minutes ago.
   */
  page(id: string): Promise<{ title: string; updated: string; live: boolean; page: RenderedPage } | { gone: true } | null>;
  linkAllowed(id: string, url: string): Promise<boolean>;
  imageAllowed(id: string, url: string): Promise<boolean>;
  remove(id: string): Promise<void>;
  /**
   * Notes today as a day of use, then gives the recaps neither published nor shown during the last `days` days of use
   * (days the browser ran, not calendar days: a week away closes nothing). `dayMs` shortens a day for tests.
   */
  stale(days: number, dayMs?: number): Promise<string[]>;
}

/** A string holding a JSON object or array becomes that value; anything else is kept as is. */
function fromJsonText(v: unknown): unknown {
  if (typeof v !== "string" || !/^\s*[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
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
  const clock = () => (o.now ?? (() => new Date()))();
  const now = () => clock().toISOString();
  const path = (id: string) => join(o.folder, `${id}.json`);
  // The mtime says when the recap was last published or shown; set from the clock so the sweep follows it.
  const touch = (id: string) => utimes(path(id), clock(), clock());

  async function read(id: string): Promise<RecapFile | null> {
    if (!ID_RECAP.test(id)) return null;
    try {
      if ((await stat(path(id))).size > RECAP_MAX_BYTES) return null;
      return RecapSchema.parse(JSON.parse(await readFile(path(id), "utf8"))) satisfies RecapFile;
    } catch {
      return null;
    }
  }

  /** Per recap, its allowed addresses as a set, while its file stays the same: a page's 100 images read it once. */
  const sets = new Map<string, { key: string; allowed: Set<string> }>();
  async function allowedSet(id: string): Promise<Set<string> | null> {
    if (!ID_RECAP.test(id)) return null;
    const st = await stat(path(id)).catch(() => null);
    if (!st) return null;
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const hit = sets.get(id);
    if (hit?.key === key) return hit.allowed;
    const f = await read(id);
    if (!f) return null;
    if (sets.size >= 50) sets.clear();
    const allowed = new Set(f.allowed);
    sets.set(id, { key, allowed });
    return allowed;
  }
  const allowedIn = async (id: string, url: string, httpsOnly: boolean) => openable(url, httpsOnly) && !!(await allowedSet(id))?.has(url);

  return {
    read,
    async publish(p) {
      const before = p.id === undefined ? null : await read(p.id);
      if (p.id !== undefined && !before) return { ok: false, errors: [RECAP_UNKNOWN] };
      // Local models (Codex on Ollama) often send these objects as JSON text.
      p = { ...p, plan: fromJsonText(p.plan), results: fromJsonText(p.results) };
      const v = validatePlan(p.plan, { catalog: BUILTIN_COMPONENTS, results: p.results });
      if (!v.ok) return v;
      // Seen now, or allowed before (a republish keeps what was read for the first version).
      const kept = new Set(before?.allowed);
      const chains = [...chainsOf(p.results)];
      const allowed = chains.filter((s) => kept.has(s) || p.seen.has(s)).slice(0, ALLOWED_MAX);
      const unread = chains.filter((s) => openable(s, false) && !allowed.includes(s));
      const at = now();
      const f: RecapFile = { version: 1, id: before?.id ?? randomUUID(), title: p.title.slice(0, RECAP_TITLE_MAX), results: p.results, plan: v.plan, allowed, updated: at, ...(p.live ? { live: true as const } : {}) };
      if (Buffer.byteLength(JSON.stringify(f)) > RECAP_MAX_BYTES) return { ok: false, errors: [RECAP_TOO_BIG] };
      await writeAtomic(path(f.id), JSON.stringify(f));
      await touch(f.id);
      return { ok: true, id: f.id, created: !before, discarded: v.discarded, unread };
    },
    async page(id) {
      if (!ID_RECAP.test(id)) return null;
      const f = await read(id);
      // Only the mtime is touched, never the content: a publish or remove in between is kept, and utimes never recreates a file.
      const stamped = await touch(id).then(() => true, (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? false : Promise.reject(e)));
      if (!stamped) return { gone: true };
      if (!f) return null;
      const live = f.live === true && clock().getTime() - Date.parse(f.updated) < LIVE_MS;
      return { title: f.title, updated: f.updated, live, page: resolvePage(f.plan, f.results, { account: false, catalog: BUILTIN_COMPONENTS, fallback: false, allowed: new Set(f.allowed) }) };
    },
    linkAllowed: (id, url) => allowedIn(id, url, false),
    imageAllowed: (id, url) => allowedIn(id, url, true),
    async remove(id) {
      if (ID_RECAP.test(id)) await rm(path(id), { force: true });
    },
    async stale(days, dayMs = DAY_MS) {
      // Local day number: a day of use starts at midnight where the user is.
      const dayOf = (t: number) => Math.floor((t - new Date(t).getTimezoneOffset() * 60_000) / dayMs);
      const usedPath = join(o.folder, USED_DAYS_FILE);
      const before = await readFile(usedPath, "utf8")
        .then((t) => z.array(z.number().int()).parse(JSON.parse(t)))
        .catch(() => [] as number[]);
      const today = dayOf(clock().getTime());
      const used = [...new Set([...before, today])].sort((a, b) => a - b).slice(-USED_DAYS_MAX);
      if (!before.includes(today)) await writeAtomic(usedPath, JSON.stringify(used));
      const names = await readdir(o.folder).catch(() => [] as string[]);
      const ids: string[] = [];
      for (const name of names) {
        const id = name.endsWith(".json") ? name.slice(0, -5) : "";
        if (!ID_RECAP.test(id)) continue;
        const mtime = await stat(path(id)).then((s) => s.mtimeMs, () => NaN);
        if (Number.isNaN(mtime)) continue;
        const shown = dayOf(mtime);
        if (used.filter((d) => d > shown).length >= days) ids.push(id);
      }
      return ids;
    },
  };
}
