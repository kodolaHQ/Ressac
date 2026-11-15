import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { queued, writeAtomic } from "../workflows/executions.js";
import type { Scope, SourceExtension } from "./manifest.js";

export type ProfileId = string;
export type IdSite = string;

export const PRIVATE_PROFILE_ERROR = "Donne à cet espace privé son propre profil pour y utiliser des extensions de l'agent";

const ScopeSchema = z.object({
  permissions: z.array(z.string()),
  hosts: z.array(z.string()),
  network: z.array(z.string()),
  allSites: z.boolean(),
  allSitesScripts: z.boolean(),
  scripts: z.boolean().optional(),
});

const EntrySchema = z.object({
  source: z.enum(["store", "agent"]),
  addonId: z.string().nullable(),
  name: z.string(),
  version: z.string(),
  grant: ScopeSchema.nullable(),
  profiles: z.array(z.string()),
  pinned: z.boolean(),
  modifiedAt: z.string().nullable(),
  disabled: z.object({ reason: z.enum(["scope-widened", "crashes"]), at: z.string() }).nullable(),
  pendingUpdate: z.object({ version: z.string(), scope: ScopeSchema, path: z.string() }).nullable(),
  seenVersions: z.record(z.string(), z.string()),
  siteApps: z.record(z.string(), z.string()).optional(),
  hiddenConsole: z.array(z.string()).optional(),
});

export interface ExtensionEntry {
  source: SourceExtension;
  /** Agent: null before the first load. */
  addonId: string | null;
  name: string;
  version: string;
  /** Scope accepted by the user; null: never granted. */
  grant: Scope | null;
  /** Profiles where the extension is active. */
  profiles: ProfileId[];
  pinned: boolean;
  /** ISO; agent: last copy reloaded. */
  modifiedAt: string | null;
  disabled: { reason: "scope-widened" | "crashes"; at: string } | null;
  /** Store. */
  pendingUpdate: { version: string; scope: Scope; path: string } | null;
  /** Last version started in each profile. */
  seenVersions: Record<ProfileId, string>;
  /**
   * Store: site apps where it is active, with the hash of their domains (`siteExtensionsHash`) at the time
   * of activation. Absent: none.
   */
  siteApps?: Record<IdSite, string>;
  /**
   * Agent: profiles where it ran in a tab the agent cannot read. Its service worker and pages console
   * stays hidden from it; never reset (its storage may have kept what it read there), erased with the entry.
   */
  hiddenConsole?: ProfileId[];
}

export interface ExtensionsState {
  version: 1;
  allCut: boolean;
  extensions: Record<string, ExtensionEntry>;
  /**
   * Chromium ids of the agent's extensions whose service worker and pages console stays hidden from it (they
   * ran in a tab it cannot read). Survives the entry's deletion: a copy recreated at the same
   * place has the same id. Never emptied.
   */
  hiddenConsoles?: string[];
}

const ID_STORE = /^[a-p]{32}$/;
const ID_AGENT = /^[a-z0-9-]{1,40}$/;
/** Ressac: an agent extension's add-on id (`<id>@agent.ressac`), its id in `consolesMasquees`. */
const ID_FIREFOX_AGENT = /^[a-z0-9-]{1,40}@agent\.ressac$/;

export function readKey(key: string): { source: SourceExtension; id: string } | null {
  const i = key.indexOf(":");
  if (i < 0) return null;
  const source = key.slice(0, i);
  const id = key.slice(i + 1);
  if (source === "store" && ID_STORE.test(id)) return { source, id };
  if (source === "agent" && ID_AGENT.test(id)) return { source, id };
  return null;
}

export function extensionKey(source: SourceExtension, id: string): string {
  const key = `${source}:${id}`;
  if (!readKey(key)) throw new Error(`identifiant d'extension invalide : ${key}`);
  return key;
}

const empty = (): ExtensionsState => ({ version: 1, allCut: false, extensions: {} });

function entryOf(e: ExtensionsState, key: string): ExtensionEntry {
  const x = e.extensions[key];
  if (!x) throw new Error(`extension inconnue : ${key}`);
  return x;
}

function updateEntry(e: ExtensionsState, key: string, change: (x: ExtensionEntry) => ExtensionEntry): ExtensionsState {
  return { ...e, extensions: { ...e.extensions, [key]: change(entryOf(e, key)) } };
}

export function enable(e: ExtensionsState, key: string, profile: ProfileId, privateProfiles: ReadonlySet<ProfileId>): ExtensionsState {
  const x = entryOf(e, key);
  if (x.source === "agent" && privateProfiles.has(profile)) throw new Error(PRIVATE_PROFILE_ERROR);
  if (!x.grant) throw new Error(`extension sans accord : ${key}`);
  return updateEntry(e, key, (y) => (y.profiles.includes(profile) ? y : { ...y, profiles: [...y.profiles, profile] }));
}

export function disable(e: ExtensionsState, key: string, profile: ProfileId): ExtensionsState {
  return updateEntry(e, key, (y) => ({ ...y, profiles: y.profiles.filter((p) => p !== profile) }));
}

export function disableEverywhere(e: ExtensionsState, key: string): ExtensionsState {
  return updateEntry(e, key, (y) => {
    const { siteApps: _, ...rest } = y;
    return { ...rest, profiles: [] };
  });
}

export function cutAll(e: ExtensionsState, yes: boolean): ExtensionsState {
  return { ...e, allCut: yes };
}

export function remove(e: ExtensionsState, key: string): ExtensionsState {
  const { [key]: _, ...rest } = e.extensions;
  return { ...e, extensions: rest };
}

export function pin(e: ExtensionsState, key: string, yes: boolean): ExtensionsState {
  return updateEntry(e, key, (y) => ({ ...y, pinned: yes }));
}

/** Removes each agent extension from private profiles; the Store ones stay. */
export function applyPrivateProfiles(
  e: ExtensionsState,
  privateProfiles: ReadonlySet<ProfileId>,
): { state: ExtensionsState; removed: { key: string; profile: ProfileId }[] } {
  const removed: { key: string; profile: ProfileId }[] = [];
  const extensions: Record<string, ExtensionEntry> = {};
  for (const [key, x] of Object.entries(e.extensions)) {
    if (x.source !== "agent") {
      extensions[key] = x;
      continue;
    }
    for (const profile of x.profiles) if (privateProfiles.has(profile)) removed.push({ key: key, profile: profile });
    extensions[key] = { ...x, profiles: x.profiles.filter((p) => !privateProfiles.has(p)) };
  }
  return { state: { ...e, extensions }, removed: removed };
}

const file = (folder: string) => join(folder, "state.json");

interface Reading {
  state: ExtensionsState;
  /** File present but unreadable, of unknown shape, or with entries that were ignored. */
  damaged: boolean;
  /** File of a newer version: empty read, write denied. */
  future: boolean;
}

async function read(folder: string): Promise<Reading> {
  let text: string;
  try {
    text = await readFile(file(folder), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: empty(), damaged: false, future: false };
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: empty(), damaged: true, future: false };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { state: empty(), damaged: true, future: false };
  const b = raw as { version?: unknown; allCut?: unknown; extensions?: unknown; hiddenConsoles?: unknown };
  if (typeof b.version === "number" && b.version > 1) return { state: empty(), damaged: false, future: true };
  if (b.version !== 1) return { state: empty(), damaged: true, future: false };
  const extensions: Record<string, ExtensionEntry> = {};
  let damaged = false;
  if (b.extensions && typeof b.extensions === "object" && !Array.isArray(b.extensions)) {
    for (const [key, value] of Object.entries(b.extensions)) {
      const parsedKey = readKey(key);
      const r = EntrySchema.safeParse(value);
      if (parsedKey && r.success && r.data.source === parsedKey.source) extensions[key] = r.data;
      else damaged = true;
    }
  } else if (b.extensions !== undefined) damaged = true;
  const hidden = Array.isArray(b.hiddenConsoles) ? b.hiddenConsoles.filter((x): x is string => typeof x === "string" && (ID_STORE.test(x) || ID_FIREFOX_AGENT.test(x))) : [];
  const state: ExtensionsState = { version: 1, allCut: b.allCut === true, extensions };
  if (hidden.length) state.hiddenConsoles = [...new Set(hidden)];
  return { state: state, damaged: damaged, future: false };
}

/**
 * The state of the file. Absent (ENOENT): empty state. Damaged or of a future version: empty state too, erasing nothing
 * (see `modifierEtatExtensions`). Throws for any read error other than ENOENT.
 */
export async function readExtensionsState(folder: string): Promise<ExtensionsState> {
  return (await read(folder)).state;
}

/** One write at a time per folder; temporary file then `rename`. */
/**
 * Modifies the state, one write at a time. `changer` receives the state and the private profiles; `profilsPrives` is a
 * provider evaluated INSIDE the serialized modification (never captured before), and `appliquerProfilsPrives` is
 * re-applied to the result. A damaged file (or one with ignored entries) is copied to `state.json.damaged-<timestamp>` before
 * being replaced; a file of a newer version refuses the write.
 */
export function changeExtensionsState(
  folder: string,
  change: (e: ExtensionsState, privateProfiles: ReadonlySet<ProfileId>) => ExtensionsState,
  privateProfiles: () => ReadonlySet<ProfileId>,
): Promise<ExtensionsState> {
  return queued(folder, async () => {
    const parsed = await read(folder);
    if (parsed.future) throw new Error("état des extensions d'une version plus récente");
    const privates = privateProfiles();
    const fresh = applyPrivateProfiles(change(parsed.state, privates), privates).state;
    if (parsed.damaged) await copyFile(file(folder), `${file(folder)}.damaged-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    await writeAtomic(file(folder), JSON.stringify(fresh, null, 2));
    return fresh;
  });
}
