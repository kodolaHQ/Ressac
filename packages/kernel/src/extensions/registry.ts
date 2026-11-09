import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Scope, SourceExtension } from "./manifest.js";

export type ProfileId = string;
export type IdSite = string;

export const PRIVATE_PROFILE_ERROR = "Donne à cet espace privé son propre profil pour y utiliser des extensions de l'agent";

const ScopeSchema = z.object({
  permissions: z.array(z.string()),
  hotes: z.array(z.string()),
  reseau: z.array(z.string()),
  tousLesSites: z.boolean(),
  scriptsTousLesSites: z.boolean(),
  scripts: z.boolean().optional(),
});

const EntrySchema = z.object({
  source: z.enum(["store", "agent"]),
  idChrome: z.string().nullable(),
  nom: z.string(),
  version: z.string(),
  accord: ScopeSchema.nullable(),
  profils: z.array(z.string()),
  epinglee: z.boolean(),
  modifieeLe: z.string().nullable(),
  desactivee: z.object({ raison: z.enum(["portee-elargie", "plantages"]), le: z.string() }).nullable(),
  majEnAttente: z.object({ version: z.string(), portee: ScopeSchema, chemin: z.string() }).nullable(),
  vues: z.record(z.string(), z.string()),
  applis: z.record(z.string(), z.string()).optional(),
  consoleMasquee: z.array(z.string()).optional(),
});

export interface ExtensionEntry {
  source: SourceExtension;
  /** Agent: null before the first load. */
  idChrome: string | null;
  nom: string;
  version: string;
  /** Scope accepted by the user; null: never granted. */
  accord: Scope | null;
  /** Profiles where the extension is active. */
  profils: ProfileId[];
  epinglee: boolean;
  /** ISO; agent: last copy reloaded. */
  modifieeLe: string | null;
  desactivee: { raison: "portee-elargie" | "plantages"; le: string } | null;
  /** Store. */
  majEnAttente: { version: string; portee: Scope; chemin: string } | null;
  /** Last version started in each profile. */
  vues: Record<ProfileId, string>;
  /**
   * Store: site apps where it is active, with the hash of their domains (`siteExtensionsHash`) at the time
   * of activation. Absent: none.
   */
  applis?: Record<IdSite, string>;
  /**
   * Agent: profiles where it ran in a tab the agent cannot read. Its service worker and pages console
   * stays hidden from it; never reset (its storage may have kept what it read there), erased with the entry.
   */
  consoleMasquee?: ProfileId[];
}

export interface ExtensionsState {
  version: 1;
  toutesCoupees: boolean;
  extensions: Record<string, ExtensionEntry>;
  /**
   * Chromium ids of the agent's extensions whose service worker and pages console stays hidden from it (they
   * ran in a tab it cannot read). Survives the entry's deletion: a copy recreated at the same
   * place has the same id. Never emptied.
   */
  consolesMasquees?: string[];
}

const ID_STORE = /^[a-p]{32}$/;
const ID_AGENT = /^[a-z0-9-]{1,40}$/;
/** WebAiOs-Firefox: an agent extension's add-on id (`<id>@agent.webaios`), its id in `consolesMasquees`. */
const ID_FIREFOX_AGENT = /^[a-z0-9-]{1,40}@agent\.webaios$/;

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

const empty = (): ExtensionsState => ({ version: 1, toutesCoupees: false, extensions: {} });

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
  if (!x.accord) throw new Error(`extension sans accord : ${key}`);
  return updateEntry(e, key, (y) => (y.profils.includes(profile) ? y : { ...y, profils: [...y.profils, profile] }));
}

export function disable(e: ExtensionsState, key: string, profile: ProfileId): ExtensionsState {
  return updateEntry(e, key, (y) => ({ ...y, profils: y.profils.filter((p) => p !== profile) }));
}

export function disableEverywhere(e: ExtensionsState, key: string): ExtensionsState {
  return updateEntry(e, key, (y) => {
    const { applis: _, ...rest } = y;
    return { ...rest, profils: [] };
  });
}

export function cutAll(e: ExtensionsState, yes: boolean): ExtensionsState {
  return { ...e, toutesCoupees: yes };
}

export function remove(e: ExtensionsState, key: string): ExtensionsState {
  const { [key]: _, ...rest } = e.extensions;
  return { ...e, extensions: rest };
}

export function pin(e: ExtensionsState, key: string, yes: boolean): ExtensionsState {
  return updateEntry(e, key, (y) => ({ ...y, epinglee: yes }));
}

/** Removes each agent extension from private profiles; the Store ones stay. */
export function applyPrivateProfiles(
  e: ExtensionsState,
  privateProfiles: ReadonlySet<ProfileId>,
): { etat: ExtensionsState; retirees: { cle: string; profil: ProfileId }[] } {
  const removed: { cle: string; profil: ProfileId }[] = [];
  const extensions: Record<string, ExtensionEntry> = {};
  for (const [key, x] of Object.entries(e.extensions)) {
    if (x.source !== "agent") {
      extensions[key] = x;
      continue;
    }
    for (const profile of x.profils) if (privateProfiles.has(profile)) removed.push({ cle: key, profil: profile });
    extensions[key] = { ...x, profils: x.profils.filter((p) => !privateProfiles.has(p)) };
  }
  return { etat: { ...e, extensions }, retirees: removed };
}

const file = (folder: string) => join(folder, "etat.json");

interface Reading {
  etat: ExtensionsState;
  /** File present but unreadable, of unknown shape, or with entries that were ignored. */
  abime: boolean;
  /** File of a newer version: empty read, write denied. */
  futur: boolean;
}

async function read(folder: string): Promise<Reading> {
  let text: string;
  try {
    text = await readFile(file(folder), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { etat: empty(), abime: false, futur: false };
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { etat: empty(), abime: true, futur: false };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { etat: empty(), abime: true, futur: false };
  const b = raw as { version?: unknown; toutesCoupees?: unknown; extensions?: unknown; consolesMasquees?: unknown };
  if (typeof b.version === "number" && b.version > 1) return { etat: empty(), abime: false, futur: true };
  if (b.version !== 1) return { etat: empty(), abime: true, futur: false };
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
  const hidden = Array.isArray(b.consolesMasquees) ? b.consolesMasquees.filter((x): x is string => typeof x === "string" && (ID_STORE.test(x) || ID_FIREFOX_AGENT.test(x))) : [];
  const state: ExtensionsState = { version: 1, toutesCoupees: b.toutesCoupees === true, extensions };
  if (hidden.length) state.consolesMasquees = [...new Set(hidden)];
  return { etat: state, abime: damaged, futur: false };
}

/**
 * The state of the file. Absent (ENOENT): empty state. Damaged or of a future version: empty state too, erasing nothing
 * (see `modifierEtatExtensions`). Throws for any read error other than ENOENT.
 */
export async function readExtensionsState(folder: string): Promise<ExtensionsState> {
  return (await read(folder)).etat;
}

/** One write at a time per folder; temporary file then `rename`. */
const files = new Map<string, Promise<unknown>>();

/**
 * Modifies the state, one write at a time. `changer` receives the state and the private profiles; `profilsPrives` is a
 * provider evaluated INSIDE the serialized modification (never captured before), and `appliquerProfilsPrives` is
 * re-applied to the result. A damaged file (or one with ignored entries) is copied to `etat.json.abime-<timestamp>` before
 * being replaced; a file of a newer version refuses the write.
 */
export function changeExtensionsState(
  folder: string,
  change: (e: ExtensionsState, privateProfiles: ReadonlySet<ProfileId>) => ExtensionsState,
  privateProfiles: () => ReadonlySet<ProfileId>,
): Promise<ExtensionsState> {
  const previous = files.get(folder) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const lu = await read(folder);
    if (lu.futur) throw new Error("état des extensions d'une version plus récente");
    const privates = privateProfiles();
    const fresh = applyPrivateProfiles(change(lu.etat, privates), privates).etat;
    await mkdir(folder, { recursive: true });
    if (lu.abime) await copyFile(file(folder), `${file(folder)}.abime-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    const temp = `${file(folder)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(fresh, null, 2));
      await rename(temp, file(folder));
    } finally {
      await rm(temp, { force: true });
    }
    return fresh;
  });
  files.set(folder, next);
  void next.finally(() => {
    if (files.get(folder) === next) files.delete(folder);
  }).catch(() => {});
  return next;
}
