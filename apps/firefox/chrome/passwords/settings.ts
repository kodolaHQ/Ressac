import type { PasswordResult, SavedLogin } from "../../shared/api";
import { reauth } from "../agent/reauth";
import { macScreenLocked, testTimes } from "../passport/settings";

/** What is read of an nsILoginInfo. */
export type LoginLike = { guid: string; origin: string; username: string; password: string };

const UNLOCK_MS = 5 * 60_000;
const SHOW_MS = 20_000;
const SCREEN_POLL_MS = 2_000;

/** An http(s) origin with a host (a bare « exemple.fr » is taken as https), else null. */
function cleanLoginOrigin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+([:/?#]|$)/i.test(s) ? s : `https://${s}`);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname ? url.origin : null;
  } catch {
    return null;
  }
}
const hostOf = (origin: string) => {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.host : origin;
  } catch {
    return origin;
  }
};

/**
 * Réglages › Mots de passe in chrome: Firefox's saved logins (`Services.logins`), the same Touch ID token shape as the
 * passport (chrome/passport/settings.ts). Without a token, only sites and usernames. Showing, copying a password and
 * every write need a live token; a sleeping Mac, a locked screen or 5 minutes revoke it. A Firefox primary password
 * refuses everything (reading would prompt for it).
 */
export function createPasswordSettings(o: {
  logins: {
    all(): Promise<LoginLike[]>;
    add(l: { origin: string; username: string; password: string }): Promise<string>;
    modify(guid: string, c: { username: string; password: string }): Promise<void>;
    remove(guid: string): Promise<void>;
    primaryPassword(): boolean;
  };
  reauth(reason: string): Promise<boolean>;
  copy(text: string, concealed: boolean): void;
  now?: () => number;
  times?: { unlockMs: number; showMs: number };
  /** Polled while a token lives; the platform has no screen-lock notification. */
  screenLocked?: () => boolean;
}) {
  const now = o.now ?? Date.now;
  const times = o.times ?? { unlockMs: UNLOCK_MS, showMs: SHOW_MS };
  const tokens = new Map<string, number>();
  const listeners = new Set<() => void>();
  let poll: ReturnType<typeof setTimeout> | undefined;

  const live = (token: unknown) => {
    const until = typeof token === "string" ? tokens.get(token) : undefined;
    return until !== undefined && now() < until && !o.logins.primaryPassword();
  };
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
    // A system module has setTimeout but no setInterval: the tick re-arms itself.
    const tick = () => {
      for (const [k, until] of tokens) if (now() >= until) tokens.delete(k);
      if (!tokens.size) return stopPoll();
      if (o.screenLocked!()) return lockAll();
      poll = setTimeout(tick, SCREEN_POLL_MS);
    };
    poll = setTimeout(tick, SCREEN_POLL_MS);
  };

  /** Every login, none while a primary password is set: reading them would show Firefox's prompt. */
  const all = async (): Promise<LoginLike[]> => (o.logins.primaryPassword() ? [] : o.logins.all());
  const find = async (guid: unknown) => (typeof guid === "string" ? (await all()).find((l) => l.guid === guid) : undefined);
  const write = async (guid: string, f: () => Promise<unknown>): Promise<PasswordResult> => {
    try {
      await f();
      return { ok: true, guid };
    } catch (e) {
      console.error("[ressac] saved login write failed:", (e as Error)?.name);
      return { ok: false, error: "write" };
    }
  };
  /** Why a write is refused before anything is read, or null. */
  const refused = (token: unknown): PasswordResult | null => (o.logins.primaryPassword() ? { ok: false, error: "primary" } : live(token) ? null : { ok: false, error: "locked" });

  return {
    async list(): Promise<SavedLogin[]> {
      try {
        return (await all())
          .map(({ guid, origin, username }) => ({ guid, origin, host: hostOf(origin), username }))
          .sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username));
      } catch (e) {
        console.error("[ressac] saved logins unreadable:", (e as Error)?.name);
        return [];
      }
    },
    async unlock(reason: string): Promise<{ token: string; until: number; showMs: number } | null> {
      if (o.logins.primaryPassword() || !(await o.reauth(String(reason)))) return null;
      const token = crypto.randomUUID();
      const until = now() + times.unlockMs;
      tokens.set(token, until);
      watchScreen();
      return { token, until, showMs: times.showMs };
    },
    lock(token: string) {
      tokens.delete(token);
    },
    lockAll,
    onLocked(cb: () => void): () => void {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    async reveal(token: string, guid: string): Promise<string | null> {
      return live(token) ? ((await find(guid))?.password ?? null) : null;
    },
    async copyPassword(token: string, guid: string): Promise<boolean> {
      const l = live(token) ? await find(guid) : undefined;
      if (!l) return false;
      o.copy(l.password, true);
      return true;
    },
    /** No token: the username is listed already. */
    async copyUsername(guid: string): Promise<boolean> {
      const l = await find(guid);
      if (!l) return false;
      o.copy(l.username, false);
      return true;
    },
    async add(token: string, l: { origin: string; username: string; password: string }): Promise<PasswordResult> {
      const no = refused(token);
      if (no) return no;
      const origin = cleanLoginOrigin(l?.origin);
      if (!origin) return { ok: false, error: "origin" };
      const [username, password] = [typeof l.username === "string" ? l.username : "", typeof l.password === "string" ? l.password : ""];
      if (!password) return { ok: false, error: "password" };
      if ((await all()).some((k) => k.origin === origin && k.username === username)) return { ok: false, error: "duplicate" };
      try {
        return { ok: true, guid: await o.logins.add({ origin, username, password }) };
      } catch (e) {
        console.error("[ressac] saved login add failed:", (e as Error)?.name);
        return { ok: false, error: "write" };
      }
    },
    /** The origin stays: only the username and the password change. */
    async edit(token: string, guid: string, c: { username: string; password: string }): Promise<PasswordResult> {
      const no = refused(token);
      if (no) return no;
      const logins = await all();
      const l = logins.find((k) => k.guid === guid);
      if (!l) return { ok: false, error: "missing" };
      const [username, password] = [typeof c?.username === "string" ? c.username : "", typeof c?.password === "string" ? c.password : ""];
      if (!password) return { ok: false, error: "password" };
      // Firefox keeps twins (a form login and an HTTP-auth one, old imports): only a username change can make a new one.
      if (username !== l.username && logins.some((k) => k !== l && k.origin === l.origin && k.username === username)) return { ok: false, error: "duplicate" };
      return write(l.guid, () => o.logins.modify(l.guid, { username, password }));
    },
    async remove(token: string, guid: string): Promise<PasswordResult> {
      const no = refused(token);
      if (no) return no;
      const l = await find(guid);
      return l ? write(l.guid, () => o.logins.remove(l.guid)) : { ok: false, error: "missing" };
    },
    primaryPassword: () => o.logins.primaryPassword(),
  };
}

export type PasswordSettings = ReturnType<typeof createPasswordSettings>;

/** Firefox's login manager behind the module's `logins`. */
function firefoxLogins() {
  const { LoginHelper } = ChromeUtils.importESModule("resource://gre/modules/LoginHelper.sys.mjs");
  const byGuid = async (guid: string) => {
    const [l] = await Services.logins.searchLoginsAsync({ guid });
    if (!l) throw new Error("missing");
    return l;
  };
  return {
    all: async (): Promise<LoginLike[]> =>
      (await Services.logins.getAllLogins()).map((l: any) => ({ guid: l.QueryInterface(Ci.nsILoginMetaInfo).guid, origin: l.origin, username: l.username, password: l.password })),
    async add(l: { origin: string; username: string; password: string }): Promise<string> {
      // As about:logins adds one by hand: no form action (any form of the origin), no field names.
      const info = LoginHelper.vanillaObjectToLogin({ origin: l.origin, formActionOrigin: "", httpRealm: null, username: l.username, password: l.password, usernameField: "", passwordField: "" });
      return (await Services.logins.addLoginAsync(info)).QueryInterface(Ci.nsILoginMetaInfo).guid;
    },
    async modify(guid: string, c: { username: string; password: string }) {
      await Services.logins.modifyLoginAsync(await byGuid(guid), LoginHelper.newPropertyBag(c));
    },
    async remove(guid: string) {
      await Services.logins.removeLoginAsync(await byGuid(guid));
    },
    primaryPassword: (): boolean => LoginHelper.isPrimaryPasswordSet(),
  };
}

let shared: PasswordSettings | undefined;
/** The chrome's one instance, for every Réglages page (tokens and relock shared). */
export function passwordSettings(): PasswordSettings {
  if (shared) return shared;
  const clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
  const s = (shared = createPasswordSettings({
    logins: firefoxLogins(),
    reauth: (reason) => reauth(reason),
    // Sensitive: private data on the transferable, macOS's concealed type (clipboard managers skip it).
    copy: (text, concealed) => clipboard.copyString(text, null, concealed ? Ci.nsIClipboardHelper.Sensitive : Ci.nsIClipboardHelper.NotSensitive),
    times: testTimes() ?? { unlockMs: UNLOCK_MS, showMs: SHOW_MS },
    screenLocked: macScreenLocked(),
  }));
  Services.obs.addObserver(() => s.lockAll(), "sleep_notification");
  return s;
}
