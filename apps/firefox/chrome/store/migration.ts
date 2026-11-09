import { constants, copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FutureFormatError, KNOWN_FORMAT, readMarker, writeMarkerHalf } from "../../../../packages/kernel/src/migration/marker";
import { ROUTES } from "../../../../packages/kernel/src/migration/names";
import { renameJson, type Rule } from "../../../../packages/kernel/src/migration/rename";
import type { ContainerService } from "./containers";

const PROFILE = { defaut: "default" };

/** `webaios://<route>…` and a builder try's run (`-essai`) as they are named now. */
const url = (u: string) =>
  u.replace(/^webaios:\/\/([^/?#]+)/, (m, route: string) => (ROUTES[route] ? `webaios://${ROUTES[route]}` : m)).replace(/^(webaios:\/\/action\/[^/]+\/[0-9TZ-]+)-essai$/, "$1-attempt");

const SESSION: Rule = {
  records: { tabs: null, "windows.*.order": null, "windows.*.active": null },
  values: {
    "spaces.*.profile": PROFILE,
    "profiles.*.id": PROFILE,
    "tabs.*.link.type": { essentiel: "essential", epingle: "pinned" },
    "tabs.*.url": url,
    "essentials.*.url": url,
    "spaces.*.pinned.*.url": url,
    "windows.*.recentlyClosed.*.url": url,
  },
};

type Change = { path: string; text: string };

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

const readJson = async (p: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    // Absent or unreadable: nothing to migrate here (loadSession sets an unreadable session aside).
    return undefined;
  }
};

/** session.json v1/v2 (French keys) → v3. Version 3 or unreadable: left. */
async function sessionChange(dataDir: string): Promise<Change | null> {
  const path = join(dataDir, "session.json");
  const v = (await readJson(path)) as { version?: unknown } | undefined;
  if (!v || typeof v !== "object" || (v.version !== 1 && v.version !== 2)) return null;
  const s = renameJson(v, SESSION) as Record<string, any>;
  // Version 1 had no private spaces nor login profiles: every space on the default profile.
  if (v.version === 1 && Array.isArray(s.spaces)) {
    s.spaces = s.spaces.map((e: object) => ({ private: false, profile: "default", ...e }));
    s.profiles ??= [{ id: "default" }];
  }
  return { path, text: JSON.stringify({ ...s, version: 3 }, null, 2) };
}

/** `permissions.json` and `permissions-<profile>.json`: `{ "<origin> <permission>": "autoriser" | "refuser" }`. */
async function permissionChanges(dataDir: string): Promise<Change[]> {
  const names = await readdir(dataDir).catch(() => [] as string[]);
  const out: Change[] = [];
  for (const name of names.filter((n) => /^permissions(-.+)?\.json$/.test(n))) {
    const path = join(dataDir, name);
    const v = await readJson(path);
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const decisions = Object.entries(v as Record<string, unknown>);
    if (!decisions.some(([, d]) => d === "autoriser" || d === "refuser")) continue;
    out.push({ path, text: JSON.stringify(Object.fromEntries(decisions.map(([k, d]) => [k, d === "autoriser" ? "allow" : d === "refuser" ? "deny" : d])), null, 2) });
  }
  return out;
}

/**
 * A full copy of `from` into a new folder `to`. A link is never followed nor copied (the migration never writes through
 * one either). Any error stops the copy: the caller migrates nothing.
 */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    const s = await lstat(join(from, name));
    if (s.isDirectory()) await copyTree(join(from, name), join(to, name));
    else if (s.isFile()) await copyFile(join(from, name), join(to, name), constants.COPYFILE_EXCL);
  }
}

async function writeAtomic(c: Change): Promise<void> {
  await writeFile(`${c.path}.tmp`, c.text);
  await rename(`${c.path}.tmp`, c.path);
}

/** The data folder could not be copied: nothing was migrated, the agent's host must not start. */
export class BackupError extends Error {
  constructor(dataDir: string, cause: unknown) {
    super(`La copie de sauvegarde de ${dataDir} a échoué (${cause instanceof Error ? cause.message : String(cause)}) : rien n'est migré et l'agent ne démarre pas.`);
    this.name = "BackupError";
  }
}

/**
 * The store half of the English formats migration, run before the session loads and before the host starts. With
 * old data: a full copy of `<dataDir>` to `<dataDir>.avant-anglais-<timestamp>` (and of the profile's containers.json
 * beside it) before any write; then session.json, permissions*.json and the default profile's container; the marker
 * `store: 2` last, so a cut run simply runs again. A new data folder only gets the marker.
 */
export async function migrateStore(o: { dataDir: string; profileDir: string; containers: ContainerService; now?: () => Date }): Promise<"done" | "already"> {
  const marker = await readMarker(o.dataDir);
  if (marker.store > KNOWN_FORMAT || marker.kernel > KNOWN_FORMAT) throw new FutureFormatError(marker);
  if (marker.store >= KNOWN_FORMAT) return "already";
  const root = await lstat(o.dataDir).catch(() => null);
  if (root && !root.isDirectory()) throw new Error(`${o.dataDir} n'est pas un dossier (lien ?) : rien n'est migré.`);
  const session = root && (await sessionChange(o.dataDir));
  const changes = root ? [...(session ? [session] : []), ...(await permissionChanges(o.dataDir))] : [];
  // The kernel's old data (its half refuses it until `store: 2`, which says this backup was made).
  const old = changes.length > 0 || (root !== null && ((await exists(join(o.dataDir, "espace"))) || (await exists(join(o.dataDir, "historique.sqlite")))));
  if (old) {
    const backup = `${o.dataDir}.avant-anglais-${(o.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-")}`;
    let started = false;
    try {
      if (await exists(backup)) throw new Error(`${backup} existe déjà`);
      started = true;
      await copyTree(o.dataDir, backup);
      const containersFile = join(o.profileDir, "containers.json");
      if (await exists(containersFile)) await copyFile(containersFile, `${backup}.containers.json`, constants.COPYFILE_EXCL);
    } catch (e) {
      // A partial copy would pass for a full one.
      if (started) await rm(backup, { recursive: true, force: true }).catch(() => {});
      throw new BackupError(o.dataDir, e);
    }
    o.containers.migrate();
    o.containers.rename("defaut", "default");
    for (const c of changes) await writeAtomic(c);
  }
  await mkdir(o.dataDir, { recursive: true });
  await writeMarkerHalf(o.dataDir, "store", KNOWN_FORMAT);
  return old ? "done" : "already";
}
