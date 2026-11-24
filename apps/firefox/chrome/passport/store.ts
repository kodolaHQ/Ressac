import { maskedDisplay, validatePassport, PASSPORT_LIMITS, PASSPORT_PROFILE as PROFILE, type PassportEntry } from "../shims/kernel";
import { passportCipher, type PassportCipher } from "./cipher";
import { setPassportHosts } from "./hosts";

const FORMAT = "ressac-passport";
const VERSION = 1;

/** Inner (clear) schema migrations, `n` takes a vN payload to vN+1; pure. Empty while the schema is at version 1. */
export const MIGRATIONS: Record<number, (v: unknown) => unknown> = {};

export type LoadResult = { profile: string; state: "ok" | "unreadable" | "newer"; entries: PassportEntry[]; dropped: number; revision: string };
type SaveResult = { ok: true; revision: string } | { ok: false; error: "stale" | "write" | "newer" | "full" };

// One key creation at a time for the whole chrome (preflight F7): two first saves on two profiles must not make two keys.
let keying: Promise<void> = Promise.resolve();

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Logs the error's name only: a message could carry a value (invariant 7). */
const logName = (what: string, e: unknown) => console.error(`[ressac] passport ${what} failed:`, (e as Error)?.name);

/**
 * One encrypted file per profile (design § 4): `<dir>/<profile>.json` = { format, version, profile, cipher }, the cipher
 * holding { version, entries }. One write at a time per profile; a revision (sha-256 of the file text) guards against a
 * save made from an older read. Never creates a key while reading, never rewrites a file it cannot read or a newer one.
 */
export function createPassportFiles(o: { dir: string; cipher: PassportCipher; now?: () => Date }) {
  const { dir, cipher } = o;
  const counts = new Map<string, number>();
  /** Per profile, at the last good load or save: each entry's field and masked display (never a value), for the tooltips. */
  const shown = new Map<string, Map<string, { field: string; display: string }>>();
  /** The last good state of a profile's passport: its hosts (agent extensions) and its shown entries. */
  const known = (profile: string, entries: readonly PassportEntry[]) => {
    setPassportHosts(profile, entries);
    if (entries.length) shown.set(profile, new Map(entries.map((e) => [e.id, { field: e.field, display: maskedDisplay(e) }])));
    else shown.delete(profile);
  };
  /** Per profile, the entries the last load could not read, as they were: every save writes them back (never lost). */
  const unread = new Map<string, unknown[]>();
  /** Profiles whose file, at the last load, must not be overwritten. */
  const readOnly = new Map<string, "unreadable" | "newer">();
  const queues = new Map<string, Promise<unknown>>();
  const path = (profile: string) => PathUtils.join(dir, `${profile}.json`);
  /** Makes the key when it is missing and `none()` still holds, after any key creation under way. */
  const keyWhen = (none: () => Promise<boolean>) =>
    (keying = keying.catch(() => {}).then(async () => {
      if (!(await cipher.available()) && (await none())) await cipher.ensureKey();
    }));

  function queued<T>(profile: string, run: () => Promise<T>): Promise<T> {
    const next = (queues.get(profile) ?? Promise.resolve()).catch(() => {}).then(run);
    queues.set(profile, next);
    return next;
  }

  /** The file's text, null when there is none; throws on any other read error. */
  async function readText(profile: string): Promise<string | null> {
    try {
      return await IOUtils.readUTF8(path(profile));
    } catch (e) {
      if ((e as Error)?.name === "NotFoundError") return null;
      throw e;
    }
  }

  async function list(): Promise<string[]> {
    const children = await IOUtils.getChildren(dir).catch(() => [] as string[]);
    return children.map((p) => PathUtils.filename(p)).filter((n) => n.endsWith(".json") && PROFILE.test(n.slice(0, -5))).map((n) => n.slice(0, -5));
  }

  /** Through the save queue: a slow load started before a save never sets its older hosts and cache after the save's. */
  const load = (profile: string): Promise<LoadResult> => queued(profile, () => loadNow(profile));

  async function loadNow(profile: string): Promise<LoadResult> {
    const unreadable = (revision = ""): LoadResult => {
      // Its hosts and shown entries stay as last known: a failed read never opens them to the agent's extensions.
      readOnly.set(profile, "unreadable");
      return { profile, state: "unreadable", entries: [], dropped: 0, revision };
    };
    if (!PROFILE.test(profile)) return { profile, state: "unreadable", entries: [], dropped: 0, revision: "" };
    let text: string | null;
    try {
      text = await readText(profile);
    } catch (e) {
      logName("read", e);
      return unreadable();
    }
    if (text === null) {
      readOnly.delete(profile);
      unread.delete(profile);
      counts.set(profile, 0);
      known(profile, []);
      return { profile, state: "ok", entries: [], dropped: 0, revision: "" };
    }
    const revision = await sha256(text);
    try {
      const env = JSON.parse(text);
      if (env?.format !== FORMAT || env.profile !== profile || typeof env.cipher !== "string" || !Number.isInteger(env.version) || env.version < 1) return unreadable(revision);
      if (!(await cipher.available())) return unreadable(revision);
      let inner = JSON.parse(await cipher.decrypt(env.cipher));
      const version = inner?.version;
      if (!Number.isInteger(version) || version < 1) return unreadable(revision);
      for (let v = version; v < VERSION; v++) inner = MIGRATIONS[v]!(inner);
      if (!Array.isArray(inner?.entries)) return unreadable(revision);
      const { kept, dropped } = validatePassport(inner.entries);
      const newer = env.version > VERSION || version > VERSION;
      // Design § 4.3: a newer file the current schema cannot read is unreadable, so the write guard keeps it.
      if (newer && inner.entries.length > 0 && kept.length === 0) return unreadable(revision);
      if (newer) readOnly.set(profile, "newer");
      else readOnly.delete(profile);
      counts.set(profile, kept.length);
      // Kept: an entry this version cannot read (malformed, invalid). Not kept: one dropped for a relational reason
      // (a repeated id, a value already kept, past the cap), which would come back once its kept twin is deleted.
      unread.set(profile, dropped.filter((d) => !d.problems.some((x) => x.code === "duplicate" || x.code === "full")).map((d) => inner.entries[d.index]));
      known(profile, kept);
      return { profile, state: newer ? "newer" : "ok", entries: kept, dropped: dropped.length, revision };
    } catch (e) {
      logName("load", e);
      return unreadable(revision);
    }
  }

  function save(profile: string, entries: PassportEntry[], revision: string): Promise<SaveResult> {
    return queued(profile, () => saveNow(profile, entries, revision));
  }

  /**
   * A load and a save as one step of the queue, so two changes at once never go stale on each other (« Retenir ce
   * site » on two rows). `change` gets the file's entries: it returns the new ones, the same array to write nothing,
   * or null to refuse. A file that is not `ok` is refused.
   */
  function update(profile: string, change: (entries: PassportEntry[]) => PassportEntry[] | null): Promise<{ ok: true; entries: PassportEntry[]; written: boolean } | { ok: false }> {
    return queued(profile, async () => {
      const r = await loadNow(profile);
      const next = r.state === "ok" ? change(r.entries) : null;
      if (!next) return { ok: false as const };
      if (next === r.entries) return { ok: true as const, entries: next, written: false };
      return (await saveNow(profile, next, r.revision)).ok ? { ok: true as const, entries: next, written: true } : { ok: false as const };
    });
  }

  async function saveNow(profile: string, entries: PassportEntry[], revision: string): Promise<SaveResult> {
    if (!PROFILE.test(profile)) return { ok: false, error: "write" };
    try {
      const current = await readText(profile);
      if ((current === null ? "" : await sha256(current)) !== revision) return { ok: false, error: "stale" };
      // The revision matches: the file is the one last loaded, so what that load found still holds.
      if (current !== null && readOnly.get(profile) === "newer") return { ok: false, error: "newer" };
      if (current !== null && readOnly.get(profile) === "unreadable") return { ok: false, error: "write" };
      if (current !== null && JSON.parse(current)?.version > VERSION) return { ok: false, error: "newer" };
      // The revision matches the last load's file, so its unread entries are this file's.
      const all = [...entries, ...(current === null ? [] : (unread.get(profile) ?? []))];
      if (all.length > PASSPORT_LIMITS.entries) return { ok: false, error: "full" };
      if (!all.length) {
        await IOUtils.remove(path(profile), { ignoreAbsent: true });
        counts.set(profile, 0);
        known(profile, []);
        return { ok: true, revision: "" };
      }
      // A new key only when none exists and no passport file does: a missing key over existing files could be a
      // keychain that refused this build, and generating would replace the real key (design § 4.2).
      await keyWhen(async () => (await list()).length === 0);
      const text = JSON.stringify({ format: FORMAT, version: VERSION, profile, cipher: await cipher.encrypt(JSON.stringify({ version: VERSION, entries: all })) });
      await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
      await IOUtils.setPermissions(dir, 0o700);
      await IOUtils.writeUTF8(path(profile), text, { tmpPath: `${path(profile)}.tmp`, flush: true });
      await IOUtils.setPermissions(path(profile), 0o600);
      counts.set(profile, entries.length);
      known(profile, entries);
      readOnly.delete(profile);
      return { ok: true, revision: await sha256(text) };
    } catch (e) {
      logName("save", e);
      return { ok: false, error: "write" };
    }
  }

  /**
   * Deletes the profile's file and every copy set aside next to it (`<profile>.…`): the user's « Supprimer ce passeport ».
   * With `revision`, only if the file is still that one (a move's source): else a StaleError, nothing removed.
   */
  function remove(profile: string, revision?: string): Promise<void> {
    return queued(profile, async () => {
      if (!PROFILE.test(profile)) return;
      if (revision !== undefined) {
        const current = await readText(profile);
        if ((current === null ? "" : await sha256(current)) !== revision) throw Object.assign(new Error("passport changed"), { name: "StaleError" });
      }
      const children = await IOUtils.getChildren(dir).catch(() => [] as string[]);
      // The passport itself last: a failure on the way leaves it whole and still masking.
      const main = `${profile}.json`;
      const mine = children.filter((p) => PathUtils.filename(p).startsWith(`${profile}.`));
      for (const p of [...mine.filter((p) => PathUtils.filename(p) !== main), ...mine.filter((p) => PathUtils.filename(p) === main)]) await IOUtils.remove(p, { ignoreAbsent: true });
      counts.delete(profile);
      unread.delete(profile);
      readOnly.delete(profile);
      known(profile, []);
    });
  }

  /**
   * « Recommencer un passeport vide » (design § 4.5): moves the file to `<profile>.illisible-<date>.json` (`~n` when
   * taken), never deletes it; its name. The next load finds no file: an empty passport.
   */
  function setAside(profile: string): Promise<string> {
    return queued(profile, async () => {
      if (!PROFILE.test(profile)) throw Object.assign(new Error("bad profile"), { name: "TypeError" });
      const d = o.now?.() ?? new Date();
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const taken = new Set((await IOUtils.getChildren(dir).catch(() => [] as string[])).map((p) => PathUtils.filename(p)));
      let name = `${profile}.illisible-${day}.json`;
      for (let n = 2; taken.has(name); n++) name = `${profile}.illisible-${day}~${n}.json`;
      // noOverwrite: a file of that name made meanwhile is never replaced (the move fails instead, nothing lost).
      await IOUtils.move(path(profile), PathUtils.join(dir, name), { noOverwrite: true });
      return name;
    });
  }

  /**
   * After a restart: makes the missing key unless another passport than `profile` is readable (its key exists, the
   * keychain only hides it now: a new one would replace it).
   */
  const ensureKeyBesides = (profile: string): Promise<void> =>
    keyWhen(async () => {
      // A cached « unreadable » is safe: this runs only while available() is false, when every file reads as unreadable.
      for (const p of await list()) if (p !== profile && (state(p) ?? (await load(p)).state) !== "unreadable") return false;
      return true;
    });

  /** An entry's field and masked display as of the last good load or save: no read, no decrypt, no prompt. */
  const shownEntry = (profile: string, id: string) => shown.get(profile)?.get(id) ?? null;

  /** The last load's or save's state, without a read; null when this profile was never loaded nor saved. */
  const state = (profile: string): LoadResult["state"] | null => readOnly.get(profile) ?? (counts.has(profile) ? "ok" : null);

  return { list, load, save, update, remove, setAside, ensureKeyBesides, count: (profile: string) => counts.get(profile) ?? 0, state, shownEntry };
}

export type PassportFiles = ReturnType<typeof createPassportFiles>;

let shared: PassportFiles | undefined;
/** The chrome's one instance, `<Firefox profile>/ressac/passport` (design § 4.1): its write guards and queues hold only within it. */
export const passportFiles = (): PassportFiles => (shared ??= createPassportFiles({ dir: PathUtils.join(PathUtils.profileDir, "ressac", "passport"), cipher: passportCipher() }));

/**
 * For the « non couverte » tooltip: each entry's field and masked display (design § 9.2) as last read, never its value
 * and never a new read; nulls for an entry gone from its passport or never read.
 */
export function passportShown(files: Pick<PassportFiles, "shownEntry">, refs: readonly { profile: string; id: string }[]): { field: string | null; display: string | null }[] {
  return refs.map((r) => files.shownEntry(r.profile, r.id) ?? { field: null, display: null });
}
