import { canonicalOf, cleanOrigin, FIELD_LABEL, PASSPORT_LIMITS, validatePassport, type PassportEntry } from "../shims/kernel";
import { testEnv } from "../test-env";
import { reauth } from "../agent/reauth";
import { passportFiles, type LoadResult, type PassportFiles } from "./store";

export type PassportSaveResult = { ok: true; revision: string; uncovered: number } | { ok: false; error: "stale" | "write" | "newer" | "full" | "locked" | "invalid" };


type Purpose = "open" | "delete" | "move" | "restart";
const PURPOSES: readonly Purpose[] = ["open", "delete", "move", "restart"];

const UNLOCK_MS = 5 * 60_000;
const SHOW_MS = 20_000;
const SCREEN_POLL_MS = 2_000;

/**
 * Réglages › Passeport in chrome (design § 9.2): Touch ID gives a random token for one profile, valid 5 minutes; reading
 * and saving need it. Without one, only each passport's entry count and state. A sleeping Mac or a locked screen revokes
 * every token and tells the pages (`onLocked`).
 */
export function createPassportSettings(o: {
  files: Pick<PassportFiles, "list" | "load" | "save" | "update" | "count" | "state" | "remove" | "setAside" | "ensureKeyBesides">;
  reauth(reason: string): Promise<boolean>;
  /** The kernel host's RPC (passport.replace, passport.drop). */
  request(method: string, params: unknown): Promise<unknown>;
  now?: () => number;
  times?: { unlockMs: number; showMs: number };
  /** Polled while a token lives; the platform has no screen-lock notification. */
  screenLocked?: () => boolean;
}) {
  const now = o.now ?? Date.now;
  const times = o.times ?? { unlockMs: UNLOCK_MS, showMs: SHOW_MS };
  /** `purpose`: what its Touch ID was asked for; a delete, move or restart token serves once and never reads. */
  const tokens = new Map<string, { profile: string; until: number; purpose: Purpose }>();
  const listeners = new Set<() => void>();
  let poll: ReturnType<typeof setTimeout> | undefined;

  const live = (profile: unknown, token: unknown, purpose: Purpose = "open") => {
    const t = typeof token === "string" ? tokens.get(token) : undefined;
    return !!t && t.profile === profile && t.purpose === purpose && now() < t.until;
  };
  /** A delete, move or restart token, used up by this call. */
  const spend = (profile: unknown, token: unknown, purpose: Purpose) => live(profile, token, purpose) && tokens.delete(token as string);
  const stopPoll = () => {
    clearTimeout(poll);
    poll = undefined;
  };
  function lockAll() {
    tokens.clear();
    stopPoll();
    for (const cb of listeners)
      try {
        cb();
      } catch {
        // A page gone without unsubscribing (dead object): forgotten.
        listeners.delete(cb);
      }
  }
  const watchScreen = () => {
    if (!o.screenLocked || poll) return;
    // A system module has setTimeout but no setInterval (a ReferenceError there broke every unlock): the tick re-arms itself.
    const tick = () => {
      for (const [k, t] of tokens) if (now() >= t.until) tokens.delete(k);
      if (!tokens.size) return stopPoll();
      if (o.screenLocked!()) return lockAll();
      poll = setTimeout(tick, SCREEN_POLL_MS);
    };
    poll = setTimeout(tick, SCREEN_POLL_MS);
  };

  /**
   * Deletes a profile's passport (design § 4.4): its file and set-aside copies, then the kernel's copy; false when the
   * file could not be removed (the kernel then keeps masking with it).
   */
  async function drop(profile: string, revision?: string): Promise<boolean> {
    if (typeof profile !== "string") return false;
    for (const [k, t] of tokens) if (t.profile === profile) tokens.delete(k);
    try {
      await o.files.remove(profile, revision);
    } catch (e) {
      console.error("[ressac] passport drop failed:", (e as Error)?.name);
      return false;
    }
    // A host that does not answer reads the files at its next start (design § 5.2): the file is gone by then.
    await o.request("passport.drop", { profile }).catch((e) => void console.error("[ressac] passport drop push failed:", (e as Error)?.name));
    return true;
  }

  return {
    /** Every passport file's entry count and state, loading (no prompt) only one never loaded. */
    async passports(): Promise<{ profile: string; count: number; state: LoadResult["state"] }[]> {
      return Promise.all(
        (await o.files.list()).map(async (profile) => ({ profile, state: o.files.state(profile) ?? (await o.files.load(profile)).state, count: o.files.count(profile) })),
      );
    },
    async unlock(profile: string, reason: string, purpose: Purpose = "open"): Promise<{ token: string; until: number; showMs: number } | null> {
      if (typeof profile !== "string" || !PURPOSES.includes(purpose) || !(await o.reauth(reason))) return null;
      const token = crypto.randomUUID();
      const until = now() + times.unlockMs;
      tokens.set(token, { profile, until, purpose });
      watchScreen();
      return { token, until, showMs: times.showMs };
    },
    async read(profile: string, token: string): Promise<{ entries: PassportEntry[]; revision: string; dropped: number } | null> {
      if (!live(profile, token)) return null;
      const r = await o.files.load(profile);
      return r.state === "unreadable" ? null : { entries: r.entries, revision: r.revision, dropped: r.dropped };
    },
    async save(profile: string, token: string, entries: PassportEntry[], revision: string): Promise<PassportSaveResult> {
      if (!live(profile, token)) return { ok: false, error: "locked" };
      // Chrome has the last word on validation (design § 9.2): the same rules as the editor, relational ones included.
      if (!Array.isArray(entries) || typeof revision !== "string" || validatePassport(entries).dropped.length) return { ok: false, error: "invalid" };
      const r = await o.files.save(profile, entries, revision);
      if (!r.ok) return r;
      // A host that does not answer reads the file at its next start (design § 5.2): no conversation to mark meanwhile.
      const host = (await o.request("passport.replace", { profile, entries }).catch((e) => void console.error("[ressac] passport push after a save failed:", (e as Error)?.name))) as
        | { uncovered?: unknown }
        | undefined;
      return { ok: true, revision: r.revision, uncovered: typeof host?.uncovered === "number" ? host.uncovered : 0 };
    },
    /**
     * « Retenir ce site » on a fill card (task 13b): the page's cleaned host joins that entry's « Remplissable sur », on
     * the file's revision, then the kernel's copy. No token: the card's « Remplir » (and its Touch ID) is the gesture, and
     * only a committed fill of that card calls this (chrome/agent/fill.ts). False when nothing was written.
     */
    async addOrigin(profile: string, id: string, origin: string): Promise<boolean> {
      try {
        const host = cleanOrigin(origin);
        if (!host) return false;
        const r = await o.files.update(profile, (all) => {
          const e = all.find((x) => x.id === id);
          if (!e || e.origins.includes(host)) return e ? all : null;
          const entries = all.map((x) => (x === e ? { ...x, origins: [...x.origins, host] } : x));
          return validatePassport(entries).dropped.length ? null : entries;
        });
        if (!r.ok) return false;
        if (!r.written) return true;
        // Origins only: the kernel marks no conversation (design § 4.3).
        await o.request("passport.replace", { profile, entries: r.entries }).catch((err) => void console.error("[ressac] passport push after a remembered site failed:", (err as Error)?.name));
        return true;
      } catch (err) {
        console.error("[ressac] passport remembered site failed:", (err as Error)?.name);
        return false;
      }
    },
    lock(token: string) {
      tokens.delete(token);
    },
    drop,
    /** « Supprimer ce passeport » (design § 4.4), behind Touch ID: a `delete` token of this profile, asked just before. */
    async removePassport(profile: string, token: string): Promise<boolean> {
      return spend(profile, token, "delete") && drop(profile);
    },
    /**
     * « Recommencer un passeport vide » (design § 4.5), with a `restart` token: an unreadable passport's file is set
     * aside (kept, never read again), the key made if no other passport is readable, and the kernel told the profile
     * is now empty (it drops its unreadable banner, ruling F9). False when refused or nothing moved.
     */
    async restart(profile: string, token: string): Promise<boolean> {
      if (!spend(profile, token, "restart")) return false;
      try {
        // Never on a readable or newer passport: only one that cannot be decrypted is given up.
        if ((await o.files.load(profile)).state !== "unreadable") return false;
        await o.files.setAside(profile);
      } catch (e) {
        console.error("[ressac] passport restart failed:", (e as Error)?.name);
        return false;
      }
      // A key that cannot be made now: the first save fails and says so, the old file is already safe.
      await o.files.ensureKeyBesides(profile).catch((e) => void console.error("[ressac] passport key after a restart failed:", (e as Error)?.name));
      if ((await o.files.load(profile)).state !== "ok") return false;
      await o.request("passport.replace", { profile, entries: [] }).catch((e) => void console.error("[ressac] passport push after a restart failed:", (e as Error)?.name));
      return true;
    },
    /**
     * « Déplacer vers… » (design § 4.4), with a `move` token of the source: merges its entries into `to` (a value `to`
     * already holds is skipped, its variants and sites joining `to`'s entry; a clashing id renewed), writes `to` and
     * pushes it, then drops the source if it is still the file copied. `unread`: the source holds entries this version
     * cannot read, which a move would lose. `copied`: `to` has them but the source was not removed (a retry finishes).
     */
    async moveTo(from: string, to: string, token: string): Promise<{ ok: true } | { ok: false; error: "locked" | "full" | "write" | "copied" | "unread" }> {
      if (!spend(from, token, "move")) return { ok: false, error: "locked" };
      if (typeof to !== "string" || to === from) return { ok: false, error: "write" };
      const [source, target] = [await o.files.load(from), await o.files.load(to)];
      if (source.state !== "ok" || target.state !== "ok") return { ok: false, error: "write" };
      if (source.dropped > 0) return { ok: false, error: "unread" };
      const into = target.entries.map((e) => ({ ...e }));
      const ids = new Set(into.map((e) => e.id));
      const incoming: PassportEntry[] = [];
      for (const e of source.entries) {
        const twin = into.find((k) => FIELD_LABEL[k.field] === FIELD_LABEL[e.field] && canonicalOf(k) === canonicalOf(e));
        if (!twin) {
          incoming.push(ids.has(e.id) ? { ...e, id: crypto.randomUUID() } : e);
          continue;
        }
        const join = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
        const [variants, origins] = [join(twin.variants, e.variants), join(twin.origins, e.origins)];
        if (variants.length > PASSPORT_LIMITS.variants || origins.length > PASSPORT_LIMITS.origins) return { ok: false, error: "full" };
        Object.assign(twin, { variants, origins });
      }
      const all = [...into, ...incoming];
      const { kept, dropped } = validatePassport(all);
      if (dropped.some((d) => d.problems.some((x) => x.code === "full"))) return { ok: false, error: "full" };
      // A target entry refused once joined with its twin's writings: never written without it.
      if (dropped.some((d) => d.index < into.length)) return { ok: false, error: "write" };
      const r = await o.files.save(to, kept, target.revision);
      if (!r.ok) return { ok: false, error: r.error === "full" ? "full" : "write" };
      // Pushed before the source goes: the kernel never lacks a value between the two, and marks nothing (ruling F8).
      await o.request("passport.replace", { profile: to, entries: kept }).catch((e) => void console.error("[ressac] passport push after a move failed:", (e as Error)?.name));
      return (await drop(from, source.revision)) ? { ok: true } : { ok: false, error: "copied" };
    },
    lockAll,
    onLocked(cb: () => void): () => void {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}

export type PassportSettings = ReturnType<typeof createPassportSettings>;

/** `RESSAC_TEST_PASSPORT_TIMES` (dev builds): « unlockMs,showMs », so an e2e waits for the relock and the remask. */
function testTimes(): { unlockMs: number; showMs: number } | undefined {
  const [unlockMs, showMs] = (testEnv("RESSAC_TEST_PASSPORT_TIMES") ?? "").split(",").map(Number);
  return unlockMs! > 0 && showMs! > 0 ? { unlockMs: unlockMs!, showMs: showMs! } : undefined;
}

/** macOS's « CGSSessionScreenIsLocked » through ctypes (CoreGraphics and CoreFoundation); false when it cannot tell. */
function macScreenLocked(): () => boolean {
  let read: (() => boolean) | null = null;
  return () => {
    try {
      if (!read) {
        const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
        const cg = ctypes.open("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
        const cf = ctypes.open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
        const ptr = ctypes.voidptr_t;
        const copySession = cg.declare("CGSessionCopyCurrentDictionary", ctypes.default_abi, ptr);
        const makeString = cf.declare("CFStringCreateWithCString", ctypes.default_abi, ptr, ptr, ctypes.char.ptr, ctypes.uint32_t);
        const getValue = cf.declare("CFDictionaryGetValue", ctypes.default_abi, ptr, ptr, ptr);
        const typeOf = cf.declare("CFGetTypeID", ctypes.default_abi, ctypes.unsigned_long, ptr);
        const boolType = cf.declare("CFBooleanGetTypeID", ctypes.default_abi, ctypes.unsigned_long);
        const boolValue = cf.declare("CFBooleanGetValue", ctypes.default_abi, ctypes.bool, ptr);
        const release = cf.declare("CFRelease", ctypes.default_abi, ctypes.void_t, ptr);
        const key = makeString(null, "CGSSessionScreenIsLocked", 0x08000100); // kCFStringEncodingUTF8, kept for the session
        read = () => {
          const session = copySession();
          if (session.isNull()) return false;
          try {
            const v = getValue(session, key);
            return !v.isNull() && String(typeOf(v)) === String(boolType()) && boolValue(v);
          } finally {
            release(session);
          }
        };
      }
      return read();
    } catch (e) {
      // Logged once, never tried again: the 5-minute relock still holds.
      console.error("[ressac] passport screen lock check failed:", (e as Error)?.name);
      read = () => false;
      return false;
    }
  };
}

let shared: PassportSettings | undefined;
/**
 * The chrome's one instance, for every Réglages page (tokens and relock shared). `request` is the kernel host's,
 * given by its first caller.
 */
export function passportSettings(request: (method: string, params: unknown) => Promise<unknown>): PassportSettings {
  if (shared) return shared;
  const s = (shared = createPassportSettings({ files: passportFiles(), reauth: (reason) => reauth(reason), request, times: testTimes() ?? { unlockMs: UNLOCK_MS, showMs: SHOW_MS }, screenLocked: macScreenLocked() }));
  Services.obs.addObserver(() => s.lockAll(), "sleep_notification");
  return s;
}
