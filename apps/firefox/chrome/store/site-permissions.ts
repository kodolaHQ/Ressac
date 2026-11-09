import type { Decision, IdFenetre, IdOnglet, IdProfil, Issue, Permission } from "../../shared/modele";
import { PROFIL_DEFAUT } from "../../shared/modele";

export type SitePermission = Permission | "partage-ecran" | "drm" | "midi";

export interface SiteRequest {
  ongletId: IdOnglet | null;
  fenetreId: IdFenetre | null;
  profil: IdProfil;
  origine: string;
  kind: string;
  mediaTypes?: readonly string[];
  lien?: string;
  /** The request is gone (its page navigated or closed): its question falls. */
  signal?: AbortSignal;
}

export interface SitePermissions {
  readonly ready: Promise<void>;
  /** Electron's traiter: true = granted. Unknown kind: false, no question. */
  handle(r: SiteRequest): Promise<boolean>;
  /** Electron's verifier, synchronous, from the remembered decisions. */
  check(profil: IdProfil, origine: string, kind: string, mediaType?: string): boolean;
  forget(profil: IdProfil, origine: string): Promise<void>;
  removeProfile(profil: IdProfil): Promise<void>;
}

interface Files {
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const SANS_DEMANDE = new Set(["fullscreen", "clipboard-sanitized-write"]);
const SIMPLE = new Set(["notifications", "geolocation", "drm", "midi", "partage-ecran"]);
/** Asked every time, never remembered. */
const NOT_KEPT = new Set<SitePermission>(["partage-ecran", "ouvrir-application"]);

/** Same names as Electron's `traduire`, plus the three new kinds; [] = unknown. */
function translate(kind: string, mediaTypes: readonly string[] = []): SitePermission[] {
  if (kind === "media") {
    const p: SitePermission[] = [];
    if (mediaTypes.includes("video")) p.push("media-camera");
    if (mediaTypes.includes("audio")) p.push("media-micro");
    return p;
  }
  return SIMPLE.has(kind) ? [kind as SitePermission] : [];
}

const key = (origine: string, p: SitePermission) => `${origine} ${p}`;

/** Electron's `fichierPermissions`: `permissions.json` for the default profile. */
const fileOf = (dir: string, id: IdProfil) => `${dir}/${id === PROFIL_DEFAUT ? "permissions.json" : `permissions-${id}.json`}`;

/** The same checks as Electron's zod schema: a flat record of "autoriser" | "refuser". */
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

/** Site permissions: asked once per (profile, origin, permission), kept in the profile's permissions file (Electron's format) and mirrored into Firefox. */
export function createSitePermissions(o: {
  dataDir: string;
  profiles: () => IdProfil[];
  ask: (d: { ongletId: IdOnglet | null; fenetreId: IdFenetre | null; origine: string; permissions: SitePermission[]; lien?: string }, signal?: AbortSignal) => Promise<Issue>;
  firefox: { set(profil: IdProfil, origine: string, p: SitePermission, d: Decision): void; remove(profil: IdProfil | null, origine: string | null): void };
  files?: Files;
}): SitePermissions {
  const files = o.files ?? defaultFiles;
  const memo = new Map<IdProfil, Record<string, Decision>>();
  const pending = new Map<string, Promise<Issue>>();
  let writes: Promise<void> = Promise.resolve();
  // A mirror failure (e.g. a hand-edited origin Firefox cannot parse) skips that entry, never the whole store.
  const mirror = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.warn("[site-permissions] not mirrored into Firefox:", e);
    }
  };
  const of = (profil: IdProfil) => memo.get(profil) ?? memo.set(profil, {}).get(profil)!;

  // Writes are chained so two decisions never race on the temporary file.
  const save = (profil: IdProfil) => {
    const text = JSON.stringify(of(profil), null, 2);
    writes = writes.then(() => files.write(fileOf(o.dataDir, profil), text)).catch((e) => console.error("[site-permissions] write failed:", e));
    return writes;
  };

  const ready = (async () => {
    // Firefox starts empty: it is rebuilt from the files, so nothing it kept on its own outlives them.
    mirror(() => o.firefox.remove(null, null));
    for (const profil of new Set([PROFIL_DEFAUT, ...o.profiles()])) {
      const path = fileOf(o.dataDir, profil);
      const text = await files.read(path);
      if (text === null) continue;
      const decisions = parse(text);
      if (!decisions) {
        console.warn(`[site-permissions] ${path} invalid: no decision loaded`);
        continue;
      }
      memo.set(profil, decisions);
      for (const [k, d] of Object.entries(decisions)) {
        const i = k.lastIndexOf(" ");
        mirror(() => o.firefox.set(profil, k.slice(0, i), k.slice(i + 1) as SitePermission, d));
      }
    }
  })();

  return {
    ready,
    async handle(r) {
      await ready;
      if (SANS_DEMANDE.has(r.kind)) return true;
      const { ongletId, fenetreId, origine, signal } = r;
      // Handing a link to another application: asked every time, with the link in view.
      if (r.kind === "openExternal") {
        if (!r.lien) return false;
        return (await o.ask({ ongletId, fenetreId, origine, permissions: ["ouvrir-application"], lien: r.lien }, signal)) === "autoriser";
      }
      const permissions = translate(r.kind, r.mediaTypes);
      if (permissions.length === 0) return false;
      if (permissions.every((p) => NOT_KEPT.has(p))) return (await o.ask({ ongletId, fenetreId, origine, permissions }, signal)) === "autoriser";
      const decisions = of(r.profil);
      const k = (p: SitePermission) => `${r.profil}\n${key(origine, p)}`;
      const unknown = permissions.filter((p) => !decisions[key(origine, p)]);
      // One question pending per (profile, origin, permission): another banner already asks it.
      const fresh = unknown.filter((p) => !pending.has(k(p)));
      if (fresh.length) {
        const answer = o.ask({ ongletId, fenetreId, origine, permissions: fresh }, signal);
        for (const p of fresh) pending.set(k(p), answer);
        const done = () => fresh.forEach((p) => pending.delete(k(p)));
        void answer.then((d) => {
          done();
          // Withdrawn without an answer (tab closed): refused this time, asked again next time.
          if (d === "retiree") return;
          for (const p of fresh) decisions[key(origine, p)] = d;
          // The profile was removed while the question was open: the answer holds for this request only.
          if (memo.get(r.profil) !== decisions) return;
          for (const p of fresh) mirror(() => o.firefox.set(r.profil, origine, p, d));
          void save(r.profil);
        }, done);
      }
      await Promise.all(unknown.map((p) => pending.get(k(p))));
      return permissions.every((p) => decisions[key(origine, p)] === "autoriser");
    },
    check(profil, origine, kind, mediaType) {
      if (SANS_DEMANDE.has(kind)) return true;
      const permissions = translate(kind, mediaType ? [mediaType] : []);
      return permissions.length > 0 && permissions.every((p) => memo.get(profil)?.[key(origine, p)] === "autoriser");
    },
    async forget(profil, origine) {
      await ready;
      const decisions = of(profil);
      for (const k of Object.keys(decisions)) if (k.startsWith(`${origine} `)) delete decisions[k];
      mirror(() => o.firefox.remove(profil, origine));
      await save(profil);
    },
    async removeProfile(profil) {
      // Synchronously, before the caller removes the container: Firefox's entries are found through it.
      memo.delete(profil);
      mirror(() => o.firefox.remove(profil, null));
      await ready;
      await (writes = writes.then(() => files.remove(fileOf(o.dataDir, profil))).catch((e) => console.error("[site-permissions] remove failed:", e)));
    },
  };
}
