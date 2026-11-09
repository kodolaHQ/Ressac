import fs from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_PROFILE, type BrowserState } from "../../shared/model";
import { initialState } from "./initial-state";

const FILE = "session.json";

const FavoriteSchema = z.object({ id: z.string(), url: z.string(), title: z.string(), favicon: z.string().nullable() });

const SpaceV1Schema = z.object({ id: z.string(), name: z.string(), icon: z.string(), pinned: z.array(FavoriteSchema) });

/** The fields common to versions 1 and 2. */
const CommonSchema = z
  .object({
    essentials: z.array(FavoriteSchema),
    tabs: z.record(
      z.string(),
      z.object({
        id: z.string(),
        windowId: z.string(),
        spaceId: z.string(),
        url: z.string(),
        title: z.string(),
        favicon: z.string().nullable(),
        link: z.object({ type: z.enum(["essential", "pinned"]), id: z.string() }).nullable(),
        openedByAgent: z.boolean(),
        zoom: z.number(),
      }),
    ),
    windows: z
      .array(
        z.object({
          id: z.string(),
          activeSpace: z.string(),
          order: z.record(z.string(), z.array(z.string())),
          active: z.record(z.string(), z.string().nullable()),
          compact: z.boolean(),
          agentPanelOpen: z.boolean(),
          recentlyClosed: z.array(z.object({ url: z.string(), spaceId: z.string() })),
          frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().default(null),
        }),
      )
      .min(1),
    settings: z.object({ engine: z.enum(["google", "duckduckgo", "qwant"]), agentProfile: z.string().min(1).default("claude"),
      agentPanelWidth: z.number().default(420),
    }),
  });

/** Version 1: before private spaces and login profiles. */
const SchemaV1 = CommonSchema.extend({ version: z.literal(1), spaces: z.array(SpaceV1Schema).min(1) });
const SchemaV2 = CommonSchema.extend({
  version: z.literal(2),
  spaces: z.array(SpaceV1Schema.extend({ private: z.boolean(), profile: z.string().min(1) })).min(1),
  profiles: z.array(z.object({ id: z.string().min(1) })),
});
const SchemaSession = z.discriminatedUnion("version", [SchemaV1, SchemaV2]);

/** Reads a saved session, whatever its version, as version 2. */
function toV2(lu: z.infer<typeof SchemaSession>): z.infer<typeof SchemaV2> {
  if (lu.version === 2) {
    // A login profile used by a space is always listed: otherwise it would be taken for a profile to erase.
    const missing = [...new Set(lu.spaces.map((e) => e.profile))].filter((id) => !lu.profiles.some((p) => p.id === id));
    return missing.length ? { ...lu, profiles: [...lu.profiles, ...missing.map((id) => ({ id }))] } : lu;
  }
  // The earlier spaces stay visible to the agent, on the always-used partition: no login is lost.
  return { ...lu, version: 2, spaces: lu.spaces.map((e) => ({ ...e, private: false, profile: DEFAULT_PROFILE })), profiles: [{ id: DEFAULT_PROFILE }] };
}

/** A tab's volatile fields are not saved: they restart from their default value. */
const VOLATILE = { loading: false, canGoBack: false, canGoForward: false, crashed: false, error: null };

/** Sets the session file aside under a unique name: the next save will not overwrite it. Returns that name. */
async function setAside(path: string, reason: "corrupt" | "unreadable"): Promise<string | null> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; ; i++) {
    const name = `${path}.${timestamp}${i ? `-${i}` : ""}.${reason}`;
    try {
      await fs.access(name);
    } catch {
      return fs.rename(path, name).then(
        () => name,
        (e) => (console.error(`[session] impossible de garder ${path} de côté :`, e), null),
      );
    }
  }
}

/** `kept` receives the name under which an unreadable session was set aside, to tell the user. */
export async function loadSession(folder: string, kept?: (path: string) => void): Promise<BrowserState> {
  const path = join(folder, FILE);
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (e) {
    // Absent: first launch. Otherwise (permissions…), keep it rather than overwrite it at the next save.
    const name = (e as NodeJS.ErrnoException).code !== "ENOENT" && (await setAside(path, "unreadable"));
    if (name) kept?.(name);
    return initialState();
  }
  try {
    const lu = toV2(SchemaSession.parse(JSON.parse(text)));
    return {
      ...lu,
      tabs: Object.fromEntries(Object.entries(lu.tabs).map(([id, o]) => [id, { ...o, ...VOLATILE }])),
    };
  } catch {
    const name = await setAside(path, "corrupt");
    if (name) kept?.(name);
    return initialState();
  }
}

/** Saves the session at most once per `delaiMs`, atomically (temporary file + rename). */
export class SessionRecorder {
  private waiting: BrowserState | null = null;
  private timer: NodeJS.Timeout | undefined;
  /** Chained writes, never simultaneous. */
  private writing: Promise<void> = Promise.resolve();
  private number = 0;

  constructor(
    private readonly folder: string,
    private readonly delayMs = 500,
  ) {}

  schedule(state: BrowserState): void {
    this.waiting = state;
    this.timer ??= setTimeout(() => void this.clear(), this.delayMs);
  }

  /** Writes the pending state; always waits for the end of the writes in progress (the app's exit depends on it). */
  clear(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const state = this.waiting;
    this.waiting = null;
    if (state) {
      this.writing = this.writing
        .then(() => this.write(state))
        .catch((e) => {
          console.error("[session] écriture impossible :", e);
          // Retried at the next write or at exit, unless a more recent state is already there.
          this.waiting ??= state;
        });
    }
    return this.writing;
  }

  private async write(state: BrowserState): Promise<void> {
    const tabs = Object.fromEntries(
      Object.entries(state.tabs).map(([id, { loading: load, canGoBack: canGoBack, canGoForward: canAdvance, crashed: crashes, error: error, ...rest }]) => [id, rest]),
    );
    const target = join(this.folder, FILE);
    const temp = `${target}.${process.pid}.${++this.number}.tmp`;
    await fs.mkdir(this.folder, { recursive: true });
    try {
      const file = await fs.open(temp, "w");
      try {
        await file.writeFile(JSON.stringify({ ...state, tabs: tabs }, null, 2));
        await file.sync(); // on disk before the rename: a power cut does not leave an empty file
      } finally {
        await file.close();
      }
      await fs.rename(temp, target);
    } catch (e) {
      await fs.rm(temp, { force: true });
      throw e;
    }
  }
}
