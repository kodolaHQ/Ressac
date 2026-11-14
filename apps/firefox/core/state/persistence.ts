import fs from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BrowserState } from "../../shared/model";
import { AURA_IDS, DEFAULT_AURA } from "../../shared/aura";
import { ClaudeEngineSchema, CodexEngineSchema, DEFAULT_CLAUDE_ENGINE, DEFAULT_CODEX_ENGINE } from "../../shared/settings";
import { FIRST_TIME, HINT_IDS, type HintId } from "../../shared/hints";
import { SHORTCUTS, SHORTCUT_IDS, bindingProblem, effectiveBindings, isBinding, pickBinding, type Binding, type ShortcutId } from "../../shared/shortcuts";
import { initialState } from "./initial-state";

const FILE = "session.json";

/** Read for sessions saved before the rename to Ressac: the app's own pages were webaios:// addresses. */
const LEGACY_SCHEME = "webaios://";
const Url = z.string().transform((u) => (u.startsWith(LEGACY_SCHEME) ? `ressac://${u.slice(LEGACY_SCHEME.length)}` : u));

const FavoriteSchema = z.object({ id: z.string(), url: Url, title: z.string(), favicon: z.string().nullable(), folder: z.string().optional() });

const SpaceSchema = z.object({ id: z.string(), name: z.string(), icon: z.string(), pinned: z.array(FavoriteSchema), folders: z.array(z.object({ id: z.string(), name: z.string(), collapsed: z.boolean() })).default([]), private: z.boolean(), profile: z.string().min(1), aura: z.enum(AURA_IDS).catch(DEFAULT_AURA) });

/** Version 3. Any other version is unreadable: set aside like a damaged session. */
const SchemaSession = z.object({
  version: z.literal(3),
  spaces: z.array(SpaceSchema).min(1),
  profiles: z.array(z.object({ id: z.string().min(1) })),
  essentials: z.array(FavoriteSchema),
  tabs: z.record(
    z.string(),
    z.object({
      id: z.string(),
      windowId: z.string(),
      spaceId: z.string(),
      url: Url,
      title: z.string(),
      favicon: z.string().nullable(),
      link: z.object({ type: z.enum(["essential", "pinned"]), id: z.string() }).nullable(),
      openedByAgent: z.boolean(),
      profile: z.string().min(1).optional(),
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
        recentlyClosed: z.array(z.object({ url: Url, spaceId: z.string() })),
        frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().default(null),
      }),
    )
    .min(1),
  settings: z.object({ engine: z.enum(["google", "duckduckgo", "qwant"]), agentProfile: z.string().min(1).default("claude"), agentPanelWidth: z.number().default(420), sidebarWidth: z.number().default(240), decisionModel: z.enum(["pplx-decider-flash", "kev"]).catch("pplx-decider-flash"), codexEngine: CodexEngineSchema.catch(() => ({ ...DEFAULT_CODEX_ENGINE })), claudeEngine: ClaudeEngineSchema.catch(() => ({ ...DEFAULT_CLAUDE_ENGINE })),
    // A session saved before the welcome existed never welcomes.
    onboarded: z.boolean().default(true),
    // A session saved before the release notes existed comes from an older version: its next launch shows them.
    seenVersion: z.string().nullable().catch(null).default(null),
    // A session saved before the hints existed has used the agent, design mode and actions: their one-time notes are seen, the tips are not.
    // An id this build does not know (a later version, a downgrade) is dropped; the rest is kept.
    hints: z
      .object({
        enabled: z.boolean().catch(true),
        seen: z.array(z.string()).transform((ids) => ids.filter((id): id is HintId => (HINT_IDS as readonly string[]).includes(id))),
      })
      // Not « extensions »: a page, not a surface they already use.
      .catch(() => ({ enabled: true, seen: (Object.keys(FIRST_TIME) as HintId[]).filter((id) => id !== "extensions") })),
    sidebarSide: z.enum(["left", "right"]).catch("left"),
    vimMode: z.boolean().catch(false),
    // A session saved before the setting existed gets the default.
    startOnHome: z.boolean().catch(true),
    // An unknown id or a malformed binding is dropped; the rest is kept.
    shortcuts: z
      .record(z.string(), z.unknown())
      .default({})
      .transform((o) => {
        const kept = Object.fromEntries(Object.entries(o).filter(([id, v]) => Object.hasOwn(SHORTCUTS, id) && isBinding(v)).map(([id, v]) => [id, pickBinding(v as Binding)])) as Partial<Record<ShortcutId, Binding>>;
        // An override that clashes with another or is reserved (a hand-edited file) is dropped, in table order.
        // Checked against every kept override, not the defaults alone: a swap (⌘J to the command bar, ⌘K to the agent) survives.
        const ok = { ...kept };
        for (const id of SHORTCUT_IDS) {
          const bd = ok[id];
          if (bd && bindingProblem(id, bd, effectiveBindings(ok))) delete ok[id];
        }
        return ok;
      })
      .catch(() => ({})),
  }),
});

/** A login profile used by a space is always listed: otherwise it would be taken for a profile to erase. */
function withProfiles(parsed: z.infer<typeof SchemaSession>): z.infer<typeof SchemaSession> {
  const missing = [...new Set(parsed.spaces.map((e) => e.profile))].filter((id) => !parsed.profiles.some((p) => p.id === id));
  return missing.length ? { ...parsed, profiles: [...parsed.profiles, ...missing.map((id) => ({ id }))] } : parsed;
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
        (e) => (console.error(`[session] could not set ${path} aside:`, e), null),
      );
    }
  }
}

/** A user who already had a session (even a damaged one) is not welcomed again. */
function known(s: BrowserState): BrowserState {
  s.settings.onboarded = true;
  return s;
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
    return name ? known(initialState()) : initialState();
  }
  try {
    const parsed = withProfiles(SchemaSession.parse(JSON.parse(text)));
    // The tabs are all still there; only what each window shows first changes.
    if (parsed.settings.startOnHome) for (const f of parsed.windows) f.active[f.activeSpace] = null;
    return {
      ...parsed,
      update: null,
      tabs: Object.fromEntries(Object.entries(parsed.tabs).map(([id, o]) => [id, { ...o, ...VOLATILE }])),
    };
  } catch {
    const name = await setAside(path, "corrupt");
    if (name) kept?.(name);
    return known(initialState());
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
          console.error("[session] write failed:", e);
          // Retried at the next write or at exit, unless a more recent state is already there.
          this.waiting ??= state;
        });
    }
    return this.writing;
  }

  private async write(state: BrowserState): Promise<void> {
    const tabs = Object.fromEntries(
      Object.entries(state.tabs).map(([id, { loading: load, canGoBack: canGoBack, canGoForward: canAdvance, crashed: crashes, error: error, agentSearch: _band, call: _call, sound: _sound, playback: _playback, unloaded: _unloaded, ...rest }]) => [id, rest]),
    );
    const target = join(this.folder, FILE);
    const temp = `${target}.${process.pid}.${++this.number}.tmp`;
    await fs.mkdir(this.folder, { recursive: true });
    try {
      const file = await fs.open(temp, "w");
      try {
        const { update: _update, ...saved } = state;
        await file.writeFile(JSON.stringify({ ...saved, tabs: tabs }, null, 2));
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
