import fs from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { APPEARANCES, FAVICON_MAX, LANGUAGE_SETTING, type BrowserState } from "../../shared/model";
import { AURA_IDS, DEFAULT_AURA } from "../../shared/aura";
import { CUSTOM_ENGINE_MAX, SEARCH_ENGINE_IDS, customEngineError } from "../../shared/search";
import { ClaudeEngineSchema, CodexEngineSchema, DEFAULT_CLAUDE_ENGINE, DEFAULT_CODEX_ENGINE, MachineIdleSchema, cleanAgentDomains } from "../../shared/settings";
import { FIRST_TIME, HINT_IDS, type HintId } from "../../shared/hints";
import { SHORTCUTS, SHORTCUT_IDS, bindingProblem, effectiveBindings, isBinding, pickBinding, type Binding, type ShortcutId } from "../../shared/shortcuts";
import { initialState } from "./initial-state";
import type { Action } from "../../shared/api";

const FILE = "session.json";

/** Icons saved before the cap are dropped at load. */
const favicon = z.string().nullable().transform((f) => (f && f.length > FAVICON_MAX ? null : f));
const FavoriteSchema = z.object({ id: z.string(), url: z.string(), title: z.string(), favicon: favicon, folder: z.string().optional(), site: z.string().regex(/^[a-z0-9-]{1,100}$/).optional(), keepLoaded: z.boolean().optional().catch(undefined) });

/** A list whose damaged entries are dropped, the rest kept: one bad tab or favorite never costs the whole session. */
const kept = <T extends z.ZodTypeAny>(schema: T) => z.array(z.unknown()).transform((list) => list.flatMap((v) => { const r = schema.safeParse(v); return r.success ? [r.data as z.infer<T>] : []; }));

const TabSchema = z.object({
  id: z.string(),
  windowId: z.string(),
  spaceId: z.string(),
  url: z.string(),
  title: z.string(),
  favicon: favicon,
  link: z.object({ type: z.enum(["essential", "pinned"]), id: z.string() }).nullable().catch(null),
  openedByAgent: z.boolean(),
  profile: z.string().min(1).optional(),
  zoom: z.number().catch(1),
});

const SpaceSchema = z.object({ id: z.string(), name: z.string(), icon: z.string(), pinned: kept(FavoriteSchema), folders: z.array(z.object({ id: z.string(), name: z.string(), collapsed: z.boolean() })).default([]), private: z.boolean(), profile: z.string().min(1), aura: z.enum(AURA_IDS).catch(DEFAULT_AURA) });

/** Version 3. Any other version is unreadable: set aside like a damaged session. */
const SchemaSession = z.object({
  version: z.literal(3),
  spaces: z.array(SpaceSchema).min(1),
  profiles: z.array(z.object({ id: z.string().min(1) })),
  essentials: kept(FavoriteSchema),
  siteBar: z.array(z.string()).catch([]),
  tabs: z.record(z.string(), z.unknown()).transform((r) => Object.fromEntries(Object.entries(r).flatMap(([id, v]) => { const t = TabSchema.safeParse(v); return t.success ? [[id, t.data]] : []; }))),
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
  settings: z.object({ engine: z.enum(SEARCH_ENGINE_IDS).catch("google"), customEngine: z.string().max(CUSTOM_ENGINE_MAX).refine((u) => !customEngineError(u)).nullable().catch(null).default(null), agentProfile: z.string().min(1).default("claude"), agentMode: z.enum(["browser", "workshop"]).catch("browser"), agentPanelWidth: z.number().default(420), sidebarWidth: z.number().default(240), codexEngine: CodexEngineSchema.catch(() => ({ ...DEFAULT_CODEX_ENGINE })), claudeEngine: ClaudeEngineSchema.catch(() => ({ ...DEFAULT_CLAUDE_ENGINE })),
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
    agentDomains: z.array(z.unknown()).transform(cleanAgentDomains).catch([]),
    machineIdleMinutes: MachineIdleSchema.catch(5),
    // A session saved before the setting existed already had AI: it stays on.
    aiEnabled: z.boolean().catch(true),
    // A session saved before the setting existed gets the default.
    startOnHome: z.boolean().catch(true),
    auraMotion: z.boolean().catch(true),
    // Missing (saved before it existed): chosen when the aura is off, the only way it could be (see below).
    auraMotionChosen: z.boolean().optional().catch(undefined),
    saveMemory: z.boolean().catch(false),
    saveMemoryChosen: z.boolean().catch(false),
    appearance: z.enum(APPEARANCES).catch("system"),
    // A session saved before languages existed was in French: it stays so. A language no longer shipped → the Mac's.
    language: z
      .string()
      .default("fr")
      .catch("system")
      .transform((l) => (LANGUAGE_SETTING.test(l) ? l : "system")),
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
  }).transform((s) => ({ ...s, auraMotionChosen: s.auraMotionChosen ?? !s.auraMotion })),
});

/** A login profile used by a space is always listed: otherwise it would be taken for a profile to erase. */
function withProfiles(parsed: z.infer<typeof SchemaSession>): z.infer<typeof SchemaSession> {
  const missing = [...new Set(parsed.spaces.map((e) => e.profile))].filter((id) => !parsed.profiles.some((p) => p.id === id));
  return missing.length ? { ...parsed, profiles: [...parsed.profiles, ...missing.map((id) => ({ id }))] } : parsed;
}

/** After dropped tabs or favorites: no window lists a tab that is gone, no tab links to a favorite that is gone. */
function consistent(parsed: z.infer<typeof SchemaSession>): z.infer<typeof SchemaSession> {
  const tabs = new Set(Object.keys(parsed.tabs));
  for (const f of parsed.windows) {
    for (const [space, list] of Object.entries(f.order)) f.order[space] = list.filter((id) => tabs.has(id));
    for (const [space, id] of Object.entries(f.active)) if (id !== null && !tabs.has(id)) f.active[space] = null;
  }
  const favorites = new Set([...parsed.essentials, ...parsed.spaces.flatMap((e) => e.pinned)].map((x) => x.id));
  for (const o of Object.values(parsed.tabs)) if (o.link && !favorites.has(o.link.id)) o.link = null;
  return parsed;
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

/** The damaged text, written next to it under a set-aside name, when the file itself could not be moved. */
async function keepCopy(path: string, text: string): Promise<string | null> {
  const name = `${path}.${new Date().toISOString().replace(/[:.]/g, "-")}.copy.corrupt`;
  return fs.writeFile(name, text).then(
    () => name,
    (e) => (console.error(`[session] could not copy ${path} aside:`, e), null),
  );
}

/** A user who already had a session (even a damaged one) is not welcomed again. */
function known(s: BrowserState, text?: string): BrowserState {
  s.settings.onboarded = true;
  // No welcome to ask: AI stays as the user left it if the damaged file still says so, else on (they already had it).
  s.settings.aiEnabled = aiEnabledIn(text) !== false;
  return s;
}

function aiEnabledIn(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : JSON.parse(text)?.settings?.aiEnabled;
  } catch {
    return undefined;
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
    return name ? known(initialState()) : initialState();
  }
  try {
    const parsed = consistent(withProfiles(SchemaSession.parse(JSON.parse(text))));
    // The tabs are all still there; only what each window shows first changes.
    if (parsed.settings.startOnHome) for (const f of parsed.windows) f.active[f.activeSpace] = null;
    return {
      ...parsed,
      update: null,
      locale: "en",
      aiSetup: false,
      welcomeReplay: false,
      tabs: Object.fromEntries(Object.entries(parsed.tabs).map(([id, o]) => [id, { ...o, ...VOLATILE }])),
    };
  } catch {
    // Neither moved nor copied: the folder takes no write, so no save will overwrite it either.
    const name = (await setAside(path, "corrupt")) ?? (await keepCopy(path, text));
    if (name) kept?.(name);
    return known(initialState(), text);
  }
}

/** A change only a tab's title, icon or volatile fields make: a ticking title (unread count) is saved on the slow timer. */
export const lazySave = (a: Action): boolean => a.type === "updateTab" && !("url" in a.fields) && !("zoom" in a.fields);

/** Saves the session `delayMs` after a change (`lazyMs` after a lazy one), atomically (temporary file + rename). */
export class SessionRecorder {
  private waiting: BrowserState | null = null;
  private timer: NodeJS.Timeout | undefined;
  private due = 0;
  /** Chained writes, never simultaneous. */
  private writing: Promise<void> = Promise.resolve();
  private number = 0;
  /** The file's text, read before the first write: an unchanged session (only volatile fields moved) is not rewritten. */
  private onDisk: string | null | undefined;

  constructor(
    private readonly folder: string,
    private readonly delayMs = 500,
    private readonly lazyMs = 5000,
  ) {}

  schedule(state: BrowserState, lazy = false): void {
    this.waiting = state;
    const due = Date.now() + (lazy ? this.lazyMs : this.delayMs);
    // A pending write already sooner keeps its time; a real change brings a lazy one forward.
    if (this.timer && this.due <= due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => void this.clear(), due - Date.now());
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
      Object.entries(state.tabs).map(([id, { loading: _load, canGoBack: _back, canGoForward: _forward, crashed: _crashed, error: _error, agentSearch: _band, call: _call, sound: _sound, playback: _playback, unloaded: _unloaded, ...rest }]) => [id, rest]),
    );
    const target = join(this.folder, FILE);
    const { update: _update, locale: _locale, aiSetup: _aiSetup, welcomeReplay: _welcomeReplay, ...saved } = state;
    const text = JSON.stringify({ ...saved, tabs: tabs });
    this.onDisk ??= await fs.readFile(target, "utf8").catch(() => null);
    if (text === this.onDisk) return;
    const temp = `${target}.${process.pid}.${++this.number}.tmp`;
    await fs.mkdir(this.folder, { recursive: true });
    try {
      const file = await fs.open(temp, "w");
      try {
        await file.writeFile(text);
        await file.sync(); // on disk before the rename: a power cut does not leave an empty file
      } finally {
        await file.close();
      }
      await fs.rename(temp, target);
      this.onDisk = text;
    } catch (e) {
      await fs.rm(temp, { force: true });
      throw e;
    }
  }
}
