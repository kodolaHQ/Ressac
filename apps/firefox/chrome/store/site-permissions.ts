import type { Decision, WindowId, TabId, ProfileId, Outcome, Permission } from "../../shared/model";
import { DEFAULT_PROFILE } from "../../shared/model";

export type SitePermission = Permission | "partage-ecran" | "drm" | "midi";

export interface SiteRequest {
  ongletId: TabId | null;
  fenetreId: WindowId | null;
  profil: ProfileId;
  origine: string;
  kind: string;
  mediaTypes?: readonly string[];
  lien?: string;
  /** The request is gone (its page navigated or closed): its question falls. */
  signal?: AbortSignal;
}

export interface SitePermissions {
  readonly ready: Promise<void>;
  /** true = granted. Unknown kind: false, no question. */
  handle(r: SiteRequest): Promise<boolean>;
  /** Synchronous, from the remembered decisions. */
  check(profile: ProfileId, origin: string, kind: string, mediaType?: string): boolean;
  forget(profile: ProfileId, origin: string): Promise<void>;
  removeProfile(profile: ProfileId): Promise<void>;
}

interface Files {
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const NO_REQUEST = new Set(["fullscreen", "clipboard-sanitized-write"]);
const SIMPLE = new Set(["notifications", "geolocation", "drm", "midi", "partage-ecran"]);
/** Asked every time, never remembered. */
const NOT_KEPT = new Set<SitePermission>(["partage-ecran", "ouvrir-application"]);

/** The kernel's permission names, plus the three new kinds; [] = unknown. */
function translate(kind: string, mediaTypes: readonly string[] = []): SitePermission[] {
  if (kind === "media") {
    const p: SitePermission[] = [];
    if (mediaTypes.includes("video")) p.push("media-camera");
    if (mediaTypes.includes("audio")) p.push("media-micro");
    return p;
  }
  return SIMPLE.has(kind) ? [kind as SitePermission] : [];
}

const key = (origin: string, p: SitePermission) => `${origin} ${p}`;

/** `permissions.json` for the default profile. */
const fileOf = (dir: string, id: ProfileId) => `${dir}/${id === DEFAULT_PROFILE ? "permissions.json" : `permissions-${id}.json`}`;

/** A flat record of "autoriser" | "refuser". */
function parse(text: string): Record<string, Decision> | null {
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((d) => d === "autoriser" || d === "refuser")) return v as Record<string, Decision>;
  } catch {
    // Unreadable JSON: treated as invalid below.
  }
  return null;
}

const defaultFiles: Files = {
  read: async (path) => {
    try {
      return await IOUtils.readUTF8(path);
    } catch {
      return null;
    }
  },
  write: async (path, text) => {
    await IOUtils.makeDirectory(path.slice(0, path.lastIndexOf("/")), { createAncestors: true, ignoreExisting: true });
    const tmp = `${path}.tmp`;
    await IOUtils.writeUTF8(tmp, text);
    await IOUtils.move(tmp, path);
  },
  remove: (path) => IOUtils.remove(path, { ignoreAbsent: true }),
};

/** Site permissions: asked once per (profile, origin, permission), kept in the profile's permissions file and mirrored into Firefox. */
export function createSitePermissions(o: {
  dataDir: string;
  profiles: () => ProfileId[];
  ask: (d: { ongletId: TabId | null; fenetreId: WindowId | null; origine: string; permissions: SitePermission[]; lien?: string }, signal?: AbortSignal) => Promise<Outcome>;
  firefox: { set(profile: ProfileId, origin: string, p: SitePermission, d: Decision): void; remove(profile: ProfileId | null, origin: string | null): void };
  files?: Files;
}): SitePermissions {
  const files = o.files ?? defaultFiles;
  const memo = new Map<ProfileId, Record<string, Decision>>();
  const pending = new Map<string, Promise<Outcome>>();
  let writes: Promise<void> = Promise.resolve();
  // A mirror failure (e.g. a hand-edited origin Firefox cannot parse) skips that entry, never the whole store.
  const mirror = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.warn("[site-permissions] not mirrored into Firefox:", e);
    }
  };
  const of = (profile: ProfileId) => memo.get(profile) ?? memo.set(profile, {}).get(profile)!;

  // Writes are chained so two decisions never race on the temporary file.
  const save = (profile: ProfileId) => {
    const text = JSON.stringify(of(profile), null, 2);
    writes = writes.then(() => files.write(fileOf(o.dataDir, profile), text)).catch((e) => console.error("[site-permissions] write failed:", e));
    return writes;
  };

  const ready = (async () => {
    // Firefox starts empty: it is rebuilt from the files, so nothing it kept on its own outlives them.
    mirror(() => o.firefox.remove(null, null));
    for (const profile of new Set([DEFAULT_PROFILE, ...o.profiles()])) {
      const path = fileOf(o.dataDir, profile);
      const text = await files.read(path);
      if (text === null) continue;
      const decisions = parse(text);
      if (!decisions) {
        console.warn(`[site-permissions] ${path} invalid: no decision loaded`);
        continue;
      }
      memo.set(profile, decisions);
      for (const [k, d] of Object.entries(decisions)) {
        const i = k.lastIndexOf(" ");
        mirror(() => o.firefox.set(profile, k.slice(0, i), k.slice(i + 1) as SitePermission, d));
      }
    }
  })();

  return {
    ready,
    async handle(r) {
      await ready;
      if (NO_REQUEST.has(r.kind)) return true;
      const { ongletId: tabId, fenetreId: windowId, origine: origin, signal } = r;
      // Handing a link to another application: asked every time, with the link in view.
      if (r.kind === "openExternal") {
        if (!r.lien) return false;
        return (await o.ask({ ongletId: tabId, fenetreId: windowId, origine: origin, permissions: ["ouvrir-application"], lien: r.lien }, signal)) === "autoriser";
      }
      const permissions = translate(r.kind, r.mediaTypes);
      if (permissions.length === 0) return false;
      if (permissions.every((p) => NOT_KEPT.has(p))) return (await o.ask({ ongletId: tabId, fenetreId: windowId, origine: origin, permissions }, signal)) === "autoriser";
      const decisions = of(r.profil);
      const k = (p: SitePermission) => `${r.profil}\n${key(origin, p)}`;
      const unknown = permissions.filter((p) => !decisions[key(origin, p)]);
      // One question pending per (profile, origin, permission): another banner already asks it.
      const fresh = unknown.filter((p) => !pending.has(k(p)));
      if (fresh.length) {
        const answer = o.ask({ ongletId: tabId, fenetreId: windowId, origine: origin, permissions: fresh }, signal);
        for (const p of fresh) pending.set(k(p), answer);
        const done = () => fresh.forEach((p) => pending.delete(k(p)));
        void answer.then((d) => {
          done();
          // Withdrawn without an answer (tab closed): refused this time, asked again next time.
          if (d === "retiree") return;
          for (const p of fresh) decisions[key(origin, p)] = d;
          // The profile was removed while the question was open: the answer holds for this request only.
          if (memo.get(r.profil) !== decisions) return;
          for (const p of fresh) mirror(() => o.firefox.set(r.profil, origin, p, d));
          void save(r.profil);
        }, done);
      }
      await Promise.all(unknown.map((p) => pending.get(k(p))));
      return permissions.every((p) => decisions[key(origin, p)] === "autoriser");
    },
    check(profile, origin, kind, mediaType) {
      if (NO_REQUEST.has(kind)) return true;
      const permissions = translate(kind, mediaType ? [mediaType] : []);
      return permissions.length > 0 && permissions.every((p) => memo.get(profile)?.[key(origin, p)] === "autoriser");
    },
    async forget(profile, origin) {
      await ready;
      const decisions = of(profile);
      for (const k of Object.keys(decisions)) if (k.startsWith(`${origin} `)) delete decisions[k];
      mirror(() => o.firefox.remove(profile, origin));
      await save(profile);
    },
    async removeProfile(profile) {
      // Synchronously, before the caller removes the container: Firefox's entries are found through it.
      memo.delete(profile);
      mirror(() => o.firefox.remove(profile, null));
      await ready;
      await (writes = writes.then(() => files.remove(fileOf(o.dataDir, profile))).catch((e) => console.error("[site-permissions] remove failed:", e)));
    },
  };
}
