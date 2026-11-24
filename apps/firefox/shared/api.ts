import { z } from "zod";
import { AURA_IDS } from "./aura";
import { HINT_IDS } from "./hints";
import { SHORTCUT_IDS, type ShortcutId } from "./shortcuts";
import { CUSTOM_ENGINE_MAX, SEARCH_ENGINE_IDS, customEngineError } from "./search";
import { APPEARANCES, LANGUAGE_SETTING, type Decision, type PendingRequest, type AccessState, type BrowserState, type SpaceId, type WindowId, type TabId, type Download, type Visit, type AskHit, type AskResult } from "./model";
import { validFolder, ID_EXECUTION, ID_SITE, PROJECT_ID, type Application, type Warning, type BlockCatalogEntry, type DeclarationWidget, type DirectState, type DraftRead, type SaveResult, type AttemptResult, type DevRight, type AiState, type WidgetState, type Execution, type ResumeExecution, type ActionsState, type PageAction, type LaunchResult, type Owner, type RenderedPage, type BatchState, type ProjectId, type ExternalProject, type TrackedProject, type Comment, type DiffFile, type ModifiedFile, type InstructionChange, type ChangedFile, type LiftChoice, type QuarantinedFile } from "@ressac/kernel";
import { ClaudeEngineSchema, CodexEngineSchema, MachineIdleSchema, type DockerStatus, type MachineShown, type AgentAccount, type Backup, type CodexEngine, type ClaudeEngine, type LoginResult, type GrantKind, type GrantRow, type SettingsResult, type WorkshopOperation, type PullProgress } from "./settings";
import type { WorkshopState } from "../../../packages/kernel/src/container/workshop.ts";
import type { PassportEntry, PassportField } from "../../../packages/kernel/src/mask/passport-fields.ts";
import type { ActionShown } from "./actions";
import type { ActionSite, SiteWindowState, MessageToHome, ShownSite } from "./sites";
import type { ExtensionsBar, ExtensionLine, SpaceExtensionLine, SiteExtensionLine } from "./extensions";
import type { LeftZone } from "./reveal";

const id = z.string().min(1);
const frame = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });
const engine = z.enum(SEARCH_ENGINE_IDS);
/** A favorite given by its address (an import), not by an open tab. */
const favoriteLink = z.object({ url: z.string().regex(/^https?:\/\//), title: z.string() });

const SchemaOpenTab = z.object({
  type: z.literal("openTab"),
  windowId: id,
  url: z.string(),
  spaceId: id.optional(),
  activate: z.boolean().optional(),
  openedByAgent: z.boolean().optional(),
  /** Absent: reached by the agent (fail closed). Only the UI's own openings say false. */
  agentReached: z.boolean().optional(),
  /** The tab whose page opened this one: its agentReached wins over the field above. */
  opener: id.optional(),
  /** The tab's own login profile, instead of its space's. */
  profile: z.string().min(1).optional(),
  after: id.optional(),
  /** Shown until the page loads (an imported tab is not loaded before it is displayed). */
  title: z.string().optional(),
});

/** The actions, validated at the entry of the main process: the schema is the source of the type. */
export const SchemaAction = z.discriminatedUnion("type", [
  SchemaOpenTab,
  /** Several tabs in one dispatch (an import): one state copy and one broadcast, not one per tab. */
  z.object({ type: z.literal("openTabs"), tabs: z.array(SchemaOpenTab) }),
  z.object({ type: z.literal("closeTab"), id }),
  /** A tab the agent opened in the user's profile leaves the « Agent » section for the user's tabs. */
  z.object({ type: z.literal("keepTab"), id }),
  /** The agent navigates the tab (or runs its code there): from now on it is reached by the agent (spec § 5.3). */
  z.object({ type: z.literal("agentNavigated"), id }),
  /**
   * The user starts their own top-level load (address bar, ⌘T): its commit (`locationCommitted`) gives the tab back.
   * The address the agent's tab already shows (« Recharger », the prefilled address) keeps it the agent's.
   */
  z.object({ type: z.literal("userNavigating"), id, url: z.string() }),
  /**
   * A top-level location change of the tab: `url` is its load's original address (before redirects), `history` a
   * back/forward or session-history load.
   */
  z.object({ type: z.literal("locationCommitted"), id, url: z.string(), history: z.boolean(), sameDocument: z.boolean() }),
  /** A site-app tweak was decided for a frame of the tab: `main` resets the tab's state at its page, a subframe only adds script. */
  z.object({ type: z.literal("tweakScript"), id, script: z.boolean(), main: z.boolean() }),
  /** A top-level load of the tab stopped: a user load that never committed (a 204, a download, « Rester ») is dropped. */
  z.object({ type: z.literal("loadStopped"), id }),
  z.object({ type: z.literal("setCall"), id, call: z.object({ mic: z.boolean(), camera: z.boolean() }).nullable() }),
  z.object({
    type: z.literal("setAgentSearch"),
    id,
    band: z.object({ state: z.enum(["working", "yours", "idle"]), text: z.string().max(300), pages: z.number().int().min(0).max(100_000), startedAt: z.number() }).nullable(),
  }),
  // garderEspace: the tab becomes its space's tab without the window changing space (an extension's request).
  z.object({ type: z.literal("activateTab"), id, keepSpace: z.boolean().optional() }),
  z.object({ type: z.literal("moveTab"), id, index: z.number().int() }),
  z.object({ type: z.literal("reopenClosedTab"), windowId: id }),
  /** Erasing the history also forgets every window's closed tabs (they have no date: all of them, whatever the period). */
  z.object({ type: z.literal("clearRecentlyClosed") }),
  z.object({
    type: z.literal("updateTab"),
    id,
    fields: z
      .object({
        url: z.string(),
        title: z.string(),
        favicon: z.string().nullable(),
        loading: z.boolean(),
        canGoBack: z.boolean(),
        canGoForward: z.boolean(),
        zoom: z.number(),
        crashed: z.boolean(),
        error: z.string().nullable(),
        sound: z.enum(["playing", "muted"]).nullable(),
        playback: z.enum(["playing", "paused"]).nullable(),
        security: z.enum(["secure", "insecure"]).nullable(),
        unloaded: z.boolean(),
        notifies: z.boolean(),
      })
      .partial(),
  }),
  z.object({ type: z.literal("openFavorite"), windowId: id, kind: z.enum(["essential", "pinned"]), id }),
  /** `folderId`: straight into that folder of the tab's space. */
  z.object({ type: z.literal("pinTab"), id, folderId: id.optional() }),
  /** A normal tab into another space, at the end of its list, in the background: its page reopens there if the login profile differs. */
  z.object({ type: z.literal("moveTabToSpace"), id, spaceId: id }),
  /** `favoriteId`: a pinned tab of the space that starts in the new folder. */
  z.object({ type: z.literal("createFolder"), spaceId: id, name: z.string().min(1), favoriteId: id.optional() }),
  z.object({ type: z.literal("renameFolder"), spaceId: id, id, name: z.string().min(1) }),
  /** A pinned tab's own name: the sidebar shows it whatever title the page takes. */
  z.object({ type: z.literal("renameFavorite"), spaceId: id, favoriteId: id, title: z.string().min(1) }),
  /** Its pinned tabs stay pinned, outside any folder. */
  z.object({ type: z.literal("deleteFolder"), spaceId: id, id }),
  z.object({ type: z.literal("toggleFolder"), spaceId: id, id }),
  /** `folderId` null: out of its folder. */
  z.object({ type: z.literal("moveToFolder"), spaceId: id, favoriteId: id, folderId: id.nullable() }),
  z.object({ type: z.literal("unpin"), spaceId: id, favoriteId: id }),
  z.object({ type: z.literal("addEssential"), id }),
  z.object({ type: z.literal("removeEssential"), favoriteId: id }),
  z.object({ type: z.literal("setKeepLoaded"), favoriteId: id, keep: z.boolean() }),
  /** A deleted site app: out of the essentials and the bar, and every tab of its container closed. */
  z.object({ type: z.literal("forgetSite"), id: z.string().regex(/^[a-z0-9-]{1,100}$/) }),
  /** A site app in the essentials (a tab in its own container, `url` required), in the sidebar bar, or nowhere. */
  z.object({ type: z.literal("placeSite"), id: z.string().regex(/^[a-z0-9-]{1,100}$/), placement: z.enum(["essentials", "bar", "none"]), url: z.string().regex(/^https?:\/\//).optional(), title: z.string().optional(), favicon: z.string().nullable().optional() }),
  /** The essential takes the place `index` in the grid. */
  z.object({ type: z.literal("moveEssential"), favoriteId: id, index: z.number().int() }),
  z.object({ type: z.literal("unloadEssential"), windowId: id, favoriteId: id }),
  /** The space takes the place `index` in the space row. */
  z.object({ type: z.literal("moveSpace"), id, index: z.number().int() }),
  /** Adds favorites by address: the space's pinned tabs, or the essentials without `spaceId`. Never a private space; a URL already there is skipped. */
  z.object({ type: z.literal("addFavorites"), spaceId: id.optional(), favorites: z.array(favoriteLink) }),
  /** `profile`: an existing login profile, or "new" to create one specific to the space. `pinned`: its first pinned tabs (an import). */
  z.object({ type: z.literal("createSpace"), name: z.string().min(1), icon: z.string().min(1), private: z.boolean(), profile: id, aura: z.enum(AURA_IDS).optional(), windowId: id.optional(), pinned: z.array(favoriteLink).optional() }),
  z.object({ type: z.literal("updateSpace"), id, name: z.string().min(1), icon: z.string().min(1), private: z.boolean(), profile: id, aura: z.enum(AURA_IDS).optional() }),
  z.object({ type: z.literal("deleteSpace"), id }),
  z.object({ type: z.literal("activateSpace"), windowId: id, id }),
  z.object({ type: z.literal("openWindow"), id: id.optional(), spaceId: id.optional() }),
  z.object({ type: z.literal("closeWindow"), id }),
  z.object({ type: z.literal("frameWindow"), id, frame }),
  // The tab leaves its window for a new one (`windowId`, `frame`: where it was dropped), its page still running.
  z.object({ type: z.literal("moveTabToNewWindow"), id, windowId: id.optional(), frame: frame.optional() }),
  z.object({ type: z.literal("showBlankPage"), windowId: id }),
  z.object({ type: z.literal("toggleCompact"), windowId: id }),
  z.object({ type: z.literal("toggleAgentPanel"), windowId: id }),
  /** Activates the Applications page of the active space, or opens it. */
  z.object({ type: z.literal("openApps"), windowId: id }),
  /** Activates this window's Extensions page, or opens it (like Applications). */
  z.object({ type: z.literal("openExtensions"), windowId: id }),
  /** Activates this window's Settings page, or opens it (like Applications). */
  z.object({ type: z.literal("openSettings"), windowId: id }),
  /** Activates the « Voir le workflow » page of widget `id` in this window, or opens it. */
  z.object({
    type: z.literal("openWorkflow"),
    windowId: id,
    id: z.string().regex(/^[a-z0-9-]+$/).max(100),
    name: z.string().max(60),
    /** An action's workflow (`ressac://workflow/action/<id>`) rather than a widget's. */
    owner: z.literal("action").optional(),
  }),
  /**
   * Activates the page of action `id` in this window (a `ressac://action/<id>[/…]` tab, in a non-private space),
   * or opens it; `execution` shows that result there.
   */
  z.object({
    type: z.literal("openAction"),
    windowId: id,
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    name: z.string().max(60),
    run: z.string().regex(ID_EXECUTION).max(64).optional(),
  }),
  /**
   * The agent's recap: activates the tab already showing it (any window, title updated), or opens it active in this
   * window; nothing in a private space.
   */
  z.object({ type: z.literal("openRecap"), windowId: id, id: z.string().regex(/^[0-9a-f-]{36}$/), title: z.string().max(120) }),
  /** Activates this window's « Actions » page, or opens it. */
  z.object({ type: z.literal("openActions"), windowId: id }),
  /** `custom`: the user's own address (https, `%s` for the words); `engine: "custom"` without it reuses the one kept. */
  z.object({ type: z.literal("chooseEngine"), engine: engine, custom: z.string().max(CUSTOM_ENGINE_MAX).refine((u) => !customEngineError(u)).optional() }),
  z.object({ type: z.literal("chooseAgentProfile"), profile: z.string().regex(/^[\w-]+$/).max(64) }),
  z.object({ type: z.literal("chooseAgentMode"), mode: z.enum(["browser", "workshop"]) }),
  z.object({ type: z.literal("chooseCodexEngine"), engine: CodexEngineSchema }),
  z.object({ type: z.literal("chooseClaudeEngine"), engine: ClaudeEngineSchema }),
  z.object({ type: z.literal("finishOnboarding"), ai: z.boolean().optional() }),
  z.object({ type: z.literal("enableAi") }),
  z.object({ type: z.literal("disableAi") }),
  z.object({ type: z.literal("finishAiSetup") }),
  z.object({ type: z.literal("replayOnboarding") }),
  /** At each start: records the running version, and opens « Nouveautés » when it changed and has notes. */
  z.object({ type: z.literal("noteVersion"), version: z.string().min(1) }),
  z.object({ type: z.literal("openReleaseNotes"), windowId: id }),
  /** Firefox's updater state (chrome only); keeps « Plus tard » unless the version changes. */
  z.object({ type: z.literal("setUpdate"), update: z.object({ phase: z.enum(["idle", "checking", "downloading", "ready", "failed", "unreachable", "unwritable", "disabled"]), version: z.string().nullable(), progress: z.number().min(0).max(100).nullable() }) }),
  /** « Plus tard » on the update card: hidden until another version is ready or the next launch. */
  z.object({ type: z.literal("dismissUpdate") }),
  z.object({ type: z.literal("markHintSeen"), id: z.enum(HINT_IDS) }),
  z.object({ type: z.literal("setHintsEnabled"), enabled: z.boolean() }),
  z.object({ type: z.literal("setVimMode"), enabled: z.boolean() }),
  z.object({ type: z.literal("chooseAgentDomains"), domains: z.array(z.string()) }),
  z.object({ type: z.literal("chooseMachineIdle"), minutes: MachineIdleSchema }),
  z.object({ type: z.literal("setSidebarSide"), side: z.enum(["left", "right"]) }),
  z.object({ type: z.literal("setStartOnHome"), enabled: z.boolean() }),
  z.object({ type: z.literal("setAuraMotion"), enabled: z.boolean() }),
  z.object({ type: z.literal("setSaveMemory"), enabled: z.boolean() }),
  z.object({ type: z.literal("chooseAppearance"), appearance: z.enum(APPEARANCES) }),
  z.object({ type: z.literal("chooseLanguage"), language: z.string().regex(LANGUAGE_SETTING) }),
  /** The chrome only: the language shown after resolving « system » (chrome/store). */
  z.object({ type: z.literal("setLocale"), locale: z.string().regex(LANGUAGE_SETTING) }),
  z.object({ type: z.literal("setShortcut"), id: z.enum(SHORTCUT_IDS), binding: z.object({ key: z.string().min(1), shift: z.boolean(), alt: z.boolean(), ctrl: z.boolean(), meta: z.boolean() }) }),
  z.object({ type: z.literal("resetShortcut"), id: z.enum(SHORTCUT_IDS) }),
  z.object({ type: z.literal("resetShortcuts") }),
  z.object({ type: z.literal("agentPanelWidth"), width: z.number().finite() }),
  z.object({ type: z.literal("sidebarWidth"), width: z.number().finite() }),
  /** Activates this window's project Review page, or opens it (one per project and per window). */
  z.object({ type: z.literal("openReview"), windowId: id, project: z.string().regex(PROJECT_ID), name: z.string().max(80) }),
]);
export type Action = z.infer<typeof SchemaAction>;

export const CommandSchema = z.union([
  z.object({ tabId: id, c: z.enum(["back", "forward", "reload", "reloadHard", "stop", "endFind", "devtools"]) }),
  z.object({ tabId: id, c: z.object({ zoom: z.enum(["in", "out", "reset"]) }) }),
  z.object({ tabId: id, c: z.object({ find: z.string(), next: z.boolean().optional(), previous: z.boolean().optional() }) }),
]);
export type TabCommand = z.infer<typeof CommandSchema>["c"];

export const BoundsSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export type BoundsRange = z.infer<typeof BoundsSchema>;

export type Panel = "history" | "downloads";
/**
 * Menu shortcuts meant for the UI (the web page often has focus). `closeTab`: ⌘W on the builder,
 * which first asks whether some code is unsaved.
 */
export type ShortcutAction = "search" | "searchNext" | "searchPrevious" | "address" | "command" | "agent" | "closeTab" | "jumpTab" | `settings:${import("./commands").SettingsSection}` | `settings:passport:${string}`;
export interface SearchResult {
  tabId: TabId;
  active: number;
  total: number;
}
/** What the agent last did and on which tab (`label`: « Lit leboncoin.fr »); `site`: its host without `www.`. */
export interface AgentViewState {
  tab: TabId;
  label: string;
  title: string;
  site: string;
  icon?: string;
  running: boolean;
}

/** The API the UI gets as `window.ressac` (ui/install-api.ts). */
export interface ApiRessac {
  windowId: WindowId;
  dispatch(action: Action): void;
  onState(callback: (e: BrowserState) => void): () => void;
  /** `ongletId` null: the input opens a new tab (blank page). */
  navigate(tabId: TabId | null, input: string): void;
  command(tabId: TabId, c: TabCommand): void;
  /** Runs a remappable shortcut's action, as its keys would (the ⌘T bar's « Commandes »). */
  runShortcut(id: ShortcutId): void;
  contentBounds(b: BoundsRange): void;
  /** macOS: the window buttons follow the sidebar (hidden with it in compact mode). */
  windowButtons(visible: boolean): void;
  /** Compact mode: over a web page, the mouse changes zone relative to the left edge (see reveal.ts). */
  onLeftZone(callback: (zone: LeftZone) => void): () => void;
  /** The menu asks to open a UI panel (⌘Y…). */
  onPanel(callback: (p: Panel) => void): () => void;
  onShortcut(callback: (r: ShortcutAction) => void): () => void;
  onSearchResult(callback: (r: SearchResult) => void): () => void;
  /** HTML fullscreen (video…): the UI fades away. */
  onFullscreen(callback: (active: boolean) => void): () => void;
  history: {
    /** `distinctes`: a single row per URL (address bar); otherwise one per URL and per space. */
    search(text: string, limit?: number, distinct?: boolean): Promise<Visit[]>;
    recent(): Promise<Visit[]>;
    /** `depuis`: ISO date; absent, the whole history. */
    clear(from?: string): Promise<void>;
    /** Forgets the text kept for a visit (a URL in a space), without deleting the visit. */
    forgetText(url: string, spaceId: string): Promise<void>;
  };
  /** The ⌘T questions (Demander): quick history search, else the agent. */
  ask: {
    /** False while the host is down or the search model is missing. */
    usable(): Promise<boolean>;
    warm(): void;
    /** Never rejects: { kind: "agent" } while the host is down. */
    find(question: string): Promise<AskResult>;
    /** Sends the question, with the pages already shown, to the window's agent and opens its panel; false when nothing was sent (panel left closed). */
    handOff(windowId: WindowId, question: string, shown: AskHit[]): Promise<boolean>;
  };
  downloads: {
    list(): Promise<Download[]>;
    open(id: string): void;
    show(id: string): void;
    cancel(id: string): void;
  };
  onDownloads(callback: (list: Download[]) => void): () => void;
  permissions: {
    pending(): Promise<PendingRequest[]>;
    /**
     * `o.confirmed`: the « Je comprends » box of a hardened extension card is checked; `o.login`: the saved login chosen on a
     * fill card; `o.remember`: its rows ticked « Retenir ce site » (this window's card only).
     */
    answer(id: string, decision: Decision, rights?: DevRight[], o?: { confirmed?: boolean; login?: number; picks?: (string | null)[]; remember?: number[] }): void;
  };
  onPermissions(callback: (list: PendingRequest[]) => void): () => void;
  /**
   * A modal opens: the keyboard returns to the UI, and the page shown by `ongletId` is captured (reduced JPEG data URL)
   * to stay visible, blurred, behind the modal. null: no page to show, or capture failed.
   */
  pagePreview(tabId: TabId | null): Promise<string | null>;
  /** This window's ⌃Tab panel: sent 200 ms after the first ⌃Tab if ⌃ is still held; null closes it. */
  onTabsPanel(callback: (p: TabsPanel | null) => void): () => void;
  /** The ⌃Tab panel acts on the current cycle (no effect outside a cycle). */
  tabCycle(m: TabCycleMessage): void;
  /** The command bar closes: the keyboard goes back to the displayed page (as soon as the UI shows it again). */
  returnFocusToPage(): void;
  /** This window's agent terminal. */
  agent: {
    /** Starts the session (or finds it again: its state and recent output are returned). */
    start(t: TerminalSize): void;
    write(d: string): void;
    resize(t: TerminalSize): void;
    onData(callback: (d: string) => void): () => void;
    onState(callback: (e: AgentPanelState) => void): () => void;
    /** Available agent profiles (the choice goes through the choisirProfilAgent action). */
    profiles(): Promise<{ id: string; name: string }[]>;
    /** The profile this window's agent runs; null when the host does not answer. */
    current(): Promise<string | null>;
    /** Chooses the profile and switches this window's agent to it; settles once the host has answered (a failure is logged, never thrown). */
    switch(profile: string): Promise<void>;
    /** After an engine change (Réglages › Agent): restarts this window's agent on the new engine, resuming its conversation. */
    relaunch(): Promise<void>;
    /** The answer on the changed-instructions card; settles once the host has answered (a failure is logged, never thrown). */
    review(id: number, choice: "keep" | "revert"): Promise<void>;
    /** What this window's panel says about masking; nothing to say while the host does not answer. */
    masking(): Promise<MaskingStatus>;
    /** The masking status may have changed (a reveal, a lift, a new conversation): read it again. */
    onMasking(callback: () => void): () => void;
    /**
     * The value behind a label of this window's own conversation, for « Voir » on a card or in the terminal: shown here
     * only, never sent to the agent. null when unknown (another conversation's, ended) or the host does not answer.
     */
    revealLocal(label: string): Promise<string | null>;
    /**
     * A paste held by this window's terminal, masked with its conversation's table: the masked text and the names of
     * what it hid (« votre IBAN »), never the original. null when the host cannot check it: nothing is pasted on its own.
     */
    maskPaste(text: string): Promise<{ text: string; names: string[] } | null>;
    /** The usernames of a fill card up in this window (`mask.loginsRef`), for its « Voir »; null when gone or another window's. */
    revealLogins(ref: string): Promise<string[] | null>;
    /** A passport value a fill card up in this window offers (`mask.rows[].choices[].ref`), for its « Voir »; null when gone or another window's. */
    revealPassport(ref: string): Promise<string | null>;
    /** The « non couverte » tooltip: each passport entry's field and masked display, never its value (nulls once removed). */
    passportShown(refs: { profile: string; id: string }[]): Promise<{ field: string | null; display: string | null }[]>;
    /** Lifting the workspace lock (spec § 3), from the panel or Réglages › Agent, with or without a conversation. */
    lock: {
      changed(): Promise<{ ok: true; files: ChangedFile[] } | { ok: false; error: string }>;
      /** A changed file's start, shown as added lines; null when it cannot be read. */
      file(path: string): Promise<DiffFile | null>;
      /** Touch ID first: refused, nothing goes to the host (`error` null). */
      lift(choice: LiftChoice, remove?: string[]): Promise<{ ok: true } | { ok: false; error: string | null }>;
      quarantine(): Promise<QuarantinedFile[]>;
      restore(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
    };
  };
  /** The agent's access to tabs (badges and bubble to cut it). */
  access: {
    state(): Promise<AccessState>;
    cut(id: TabId, right?: DevRight): void;
  };
  /** The agent's access to a tab changed: the full state is broadcast again. */
  onAccess(callback: (e: AccessState) => void): () => void;
  /** The tab the agent last acted on, never a private one: null when none, or 20 s after its last tool ended. */
  agentView: {
    state(): AgentViewState | null;
    onState(callback: (s: AgentViewState | null) => void): () => void;
    /** Thumbnails of that tab (`data:image/jpeg;base64,…`, null when it cannot be shown), taken only while someone watches. */
    watch(callback: (frame: string | null) => void): () => void;
    /** Shows that tab. */
    open(): void;
  };
  /** Home page: the widgets of the agent space's home/widgets. */
  home: {
    read(): Promise<ShownWidget[]>;
    /** A widget, its layout, its data or its state changed: re-read. */
    onChange(callback: () => void): () => void;
    /** New layout (all placed widgets); refused if a placement leaves the grid or targets an unknown id. */
    place(placements: Placement[]): void;
    /** Puts the widget in the trash (home/.trash) and removes its grant. */
    remove(id: string): void;
    /**
     * Link requested by the display of widget `id`: http(s) only, in a tab of this window. Opened only
     * if a real click of the user just landed in this widget's display (seen by the UI's listener on the frame).
     */
    open(url: string, id: string): void;
    /** Login profiles a grant can use (never a private space's). */
    profilesForGrant(): Promise<ProfileForGrant[]>;
    /**
     * The user authorizes the widget to read with their account, in this profile. `compte` and `publiques`: exactly what the
     * card showed them; refused (with the error) if the declaration changed since.
     */
    grant(a: Grant): Promise<{ ok: true } | { ok: false; error: string }>;
    /** A widget without account may read exactly the public domains and the web the banner showed; a harvest follows. */
    approveReads(a: ReadsApproval): Promise<{ ok: true } | { ok: false; error: string }>;
    /** The user refuses or removes the grant: the data read with the account is erased. */
    denyGrant(id: string): void;
    /** « Mettre à jour maintenant ». */
    harvest(id: string): void;
    /** The widget's latest executions, most recent first. */
    runs(id: string): Promise<ResumeExecution[]>;
    /** A complete execution (blocks, outputs, logs); null if it no longer exists or the id is invalid. */
    run(id: string, execution: string): Promise<Execution | null>;
  };
  /**
   * The visual builder of workflows: a widget's (page `ressac://workflow/<id>`) or an action's
   * (`ressac://workflow/action/<id>`, refused when the window's active space is private).
   */
  workflow: {
    catalog(): Promise<BlockCatalogEntry[]>;
    /** null: unknown widget or action, or without a workflow. */
    read(target: Owner): Promise<WorkflowEdit | null>;
    save(target: Owner, draft: Draft): Promise<SaveResult & { warnings: Warning[] }>;
    readCode(target: Owner, name: string): Promise<{ text: string } | { absent: true } | { error: string }>;
    saveCode(target: Owner, name: string, text: string): Promise<{ ok: true } | { ok: false; error: string }>;
    /** A trial; for an action, its page shows in the preview, never as the latest result. */
    replay(target: Owner, execution: string, block: string): Promise<AttemptResult>;
    /**
     * Starts a real execution now; returns its id (absent if the agent is stopped or nothing ran). An action
     * receives `saisie` and may return the refusal (`error`: required input, required grant…).
     */
    run(target: Owner, input?: string | null): Promise<{ run?: string; error?: string }>;
    /** The block selected in this window's builder (for open_workflow). */
    selection(target: Owner, block: string | null): void;
    /** The executions of the running widgets (those of actions: `actions.live`). */
    live(): Promise<DirectState>;
    onLive(callback: (e: DirectState) => void): () => void;
  };
  /** Local AI (the decision and search models). */
  ai: {
    state(): Promise<LocalAiStateShown>;
  };
  /**
   * The actions (`~/Ressac/actions`) and their pages. Refused when the window's active space is private
   * (`action-private`, or nothing: `[]`, `null`).
   */
  actions: {
    list(): Promise<ActionShown[]>;
    /** An action, a component or a latest result changed: re-read. */
    onChange(callback: () => void): () => void;
    /**
     * Choosing a suggestion: the action's page opens (or the one showing the running execution) and the action is
     * started, unless it is already running or its required input is missing.
     */
    open(id: string, input: string | null): Promise<{ ok: true } | { ok: false; error: string }>;
    /** « Relancer » from the page: returns the outcome of the execution, when it ends. */
    launch(id: string, input: string | null): Promise<LaunchResult>;
    stop(id: string): void;
    /** This result (null: the latest), without rerunning anything; null if there is none. */
    page(id: string, execution: string | null): Promise<PageAction | null>;
    runs(id: string): Promise<ResumeExecution[]>;
    /** A complete execution (blocks, outputs, logs), for the builder; null if it no longer exists. */
    run(id: string, execution: string): Promise<Execution | null>;
    live(): Promise<ActionsState>;
    onLive(callback: (e: ActionsState) => void): () => void;
    /** A link from the page: opened in a tab only if the address appears as is in the results. */
    openLink(id: string, execution: string, url: string): void;
    /** Login profiles a grant can use (never a private space's). */
    profilesForGrant(): Promise<ProfileForGrant[]>;
    /** As for a widget; nothing is started (the user reruns from the page). */
    grant(a: Grant): Promise<{ ok: true } | { ok: false; error: string }>;
    /** As for a widget; nothing is started (the page reruns). */
    approveReads(a: ReadsApproval): Promise<{ ok: true } | { ok: false; error: string }>;
    /** Removes the grant and erases executions, results and memory. */
    denyGrant(id: string): Promise<void>;
    /** Puts the action in the trash (`actions/.trash`) and forgets its grant and its data. */
    delete(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
    /** Opens the builder on the action's workflow. */
    viewWorkflow(id: string): void;
  };
  /**
   * The agent's recaps (`ressac://recap/<id>`), served by the host whether or not the kernel runs. Nothing in a private
   * space (`null`, no link opened).
   */
  recaps: {
    /** `gone`: closed or swept, the file is no more; null: unreadable, no host yet, or a private space. `live`: the agent is still filling it. */
    page(id: string): Promise<{ title: string; updated: string; live: boolean; page: RenderedPage } | { gone: true } | null>;
    /** A link of the page: opened in a tab only if the agent read this exact address for this recap. */
    openLink(id: string, url: string): void;
    /** The agent republished this recap (its id), or the host started again (null): re-read. */
    onChange(callback: (id: string | null) => void): () => void;
  };
  /** Applications page (projects of the agent's space). */
  apps: {
    list(): Promise<ApplicationList>;
    /** A project or an app's state changed: re-read. */
    onChange(callback: () => void): () => void;
    act(folder: string, action: ActionApplication): void;
  };
  /** « Sites » section of the Applications page: the site apps of the agent's space. */
  sites: {
    list(): Promise<ShownSite[]>;
    /** A site app appeared, changed, opened or closed: re-read. */
    onChange(callback: () => void): () => void;
    act(id: string, action: ActionSite): void;
    /** A click on app `id`'s essential (or « Accueil de l'appli »): its tab in this window shows the app's home over its page. */
    showHome(id: string): void;
    /** Whether app `id`'s essential tab can show a home (one written, no grant waiting). */
    hasHome(id: string): boolean;
  };
  extensions: {
    /** The installed or granted extensions, and the agent's folders never granted, seen from this space. */
    forSpace(spaceId: SpaceId): Promise<SpaceExtensionLine[]>;
    /** Enables or disables an extension in this space's profile (the agent without a grant goes through the card). */
    toggle(key: string, spaceId: SpaceId, active: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
    /** The extension registry changed (or their errors): re-read. */
    onChange(callback: () => void): () => void;
    /** All the registry's extensions (Extensions page). */
    list(): Promise<ExtensionLine[]>;
    /** Is « Désactiver toutes les extensions » in force? */
    allCut(): Promise<boolean>;
    /** The extensions loaded in the profile of this window's active space. */
    bar(): Promise<ExtensionsBar>;
    pin(key: string, yes: boolean): Promise<ExtensionResult>;
    /** Removed from all profiles (the grant stays). */
    disableEverywhere(key: string): Promise<ExtensionResult>;
    /** Store: uninstalled; agent: grant and copy erased (the agent's folder stays). */
    remove(key: string): Promise<ExtensionResult>;
    /** « Désactiver toutes les extensions »: nothing is loaded while it is true, even after a restart. */
    cutAll(yes: boolean): Promise<ExtensionResult>;
    /** The card of the pending update (Store) or of the widened scope (agent), in this window. */
    review(key: string): Promise<ExtensionResult>;
    /** An extension disabled for its crashes starts again (where it was active). */
    reenable(key: string): Promise<ExtensionResult>;
    /** « Couper le déblocage » of an agent extension's console. */
    cutUnlock(key: string): Promise<ExtensionResult>;
  };
  /** Design mode of this window's active tab, and baskets of notes. */
  design: ApiDesign;
  /** « Cacher pour l'agent »: the toolbar button arms (or leaves) the viewfinder over this window's tab. */
  hide: { toggle(): void; picking(): boolean; onChange(cb: () => void): () => void };
  external: ExternalApi;
  review: ReviewApi;
  settings: SettingsApi;
  browserImport: BrowserImportApi;
  bookmarks: {
    /** Places bookmarks matching the text in title or URL (http(s) only). */
    search(text: string, limit?: number): Promise<{ url: string; title: string }[]>;
  };
}

export type ImportSourceId = "arc" | "chrome" | "brave" | "edge" | "vivaldi" | "opera" | "safari" | "firefox" | "zen";
export type ImportType = "bookmarks" | "history" | "passwords" | "spaces" | "tabs";
export interface ImportSource { id: ImportSourceId; name: string; /** The installed app's icon; null when the app is not found. */ icon: string | null; types: ImportType[]; passwordsByCsv: boolean }
/** denied: macOS refused a read, which the person can allow in Réglages Système › Fichiers et dossiers. */
export interface ImportProgress { source: ImportSourceId; done: boolean; counts: Partial<Record<ImportType, number>>; failed: Partial<Record<ImportType, string>>; denied?: boolean }
/** Import from another browser on this Mac: one run at a time, in the background; a notification tells the end. */
export interface BrowserImportApi {
  /** Only the browsers whose data folder exists (no file of theirs is read). */
  sources(): Promise<ImportSource[]>;
  /** A source's profiles, the last used first: read only once the person picks that source. */
  profiles(source: ImportSourceId): Promise<{ id: string; name: string }[]>;
  /** ask: macOS 26+ wants the person's consent before Ressac reads that browser's data (nothing is read to know it). */
  access(source: ImportSourceId): Promise<"ready" | "ask">;
  /** The macOS folder picker on that browser's folder; denied: picked but still refused (Réglages Système can allow it). */
  grantAccess(source: ImportSourceId): Promise<{ ok: true } | { ok: false; error: string; denied: boolean }>;
  /** Answers at once; the import goes on in the background. */
  start(o: { source: ImportSourceId; profile: string | null; types: ImportType[] }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** The run in progress, or the last one; null before any. */
  progress(): Promise<ImportProgress | null>;
  /** A CSV export of passwords (Safari, Firefox, Zen), picked in a native file picker. */
  importPasswordsCsv(): Promise<{ ok: true; count: number } | { ok: false; error: string }>;
}

/** The settings page: agent accounts, workshop, local AI, durable grants, data, telemetry. */
export interface SettingsApi {
  agents(): Promise<AgentAccount[]>;
  /** panel: the agent panel is open on that agent, to sign in there; device: a code to enter on a page. */
  login(id: string): Promise<LoginResult>;
  logout(id: string): Promise<AgentAccount[]>;
  /** null: the host does not answer. */
  workshop(): Promise<WorkshopState | null>;
  /** Whether Docker runs, is installed but stopped, or is missing (null: the host does not answer). */
  docker(): Promise<DockerStatus | null>;
  /** Starts the installed container app and waits for Docker to answer. */
  startDocker(): Promise<SettingsResult>;
  /** The workshop machine's state (null: the host does not answer). */
  machine(): Promise<MachineShown | null>;
  /** null: no machine, or the host does not answer. */
  machineUsage(): Promise<{ memoryMB: number; diskMB: number } | null>;
  /** Downloads and starts the machine again (after an error). */
  machineInstall(): Promise<SettingsResult>;
  /** Keeps the logins unless `force` (a damaged machine whose logins cannot be saved). */
  machineRemove(force: boolean): Promise<SettingsResult>;
  /** The machine takes over now, cutting the agent sessions still open in Docker's workshop. */
  machineSwitchNow(): Promise<SettingsResult>;
  /** Refused while another restart or rebuild runs (from any page or window). */
  restartWorkshop(fresh: boolean): Promise<SettingsResult>;
  workshopOperation(): Promise<WorkshopOperation>;
  codexKeySaved(): Promise<boolean>;
  setCodexKey(key: string): Promise<SettingsResult>;
  deleteCodexKey(): Promise<SettingsResult>;
  amoAccount(): Promise<{ saved: boolean; issuer: string | null }>;
  setAmoAccount(issuer: string, secret: string): Promise<SettingsResult>;
  deleteAmoAccount(): Promise<SettingsResult>;
  chooseCodexEngine(engine: CodexEngine): void;
  claudeKeySaved(): Promise<boolean>;
  setClaudeKey(key: string): Promise<SettingsResult>;
  deleteClaudeKey(): Promise<SettingsResult>;
  chooseClaudeEngine(engine: ClaudeEngine): void;
  /** Downloads one of Ressac's missing models. Refused while another download runs. */
  pullModel(name: string): Promise<SettingsResult>;
  /** The pull in progress (from any window), null when none. */
  pullProgress(): Promise<PullProgress | null>;
  /** The agent that writes for the AI (its account signed in, workshop running), "workshop-stopped", or null (no account). */
  writer(): Promise<{ agent: "claude" | "codex" | "workshop-stopped" | null }>;
  /** Downloads the given models one after the other without waiting; a system notification says the end. */
  pullInBackground(names: string[]): Promise<SettingsResult>;
  ollamaModels(url: string): Promise<{ ok: true; models: { name: string; size?: string; cloud?: true }[] } | { ok: false; error: string }>;
  grants(): Promise<GrantRow[]>;
  revoke(kind: GrantKind, key: string): Promise<void>;
  dataDir(): string;
  /** Slow with big backups (their size is measured): loaded apart from the data folder. */
  backups(): Promise<Backup[]>;
  reveal(path: string): void;
  deleteBackup(path: string): Promise<SettingsResult>;
  /** Reveals the file once written. */
  exportData(): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  /** Marks the data to set aside and restarts; false when the restart was cancelled (nothing is reset then). */
  reset(): Promise<boolean>;
  telemetry(): Promise<{ available: boolean; enabled: boolean; crashReports: boolean }>;
  setTelemetry(enabled: boolean): void;
  /** Firefox's crash reports (minidumps, unscrubbed), off by default; they also need the telemetry switch on. */
  setCrashReports(on: boolean): void;
  version(): Promise<string>;
  /** Whether macOS opens web links with Ressac. */
  defaultBrowser(): Promise<boolean>;
  /** macOS asks for confirmation itself: read `defaultBrowser()` again for the answer. */
  setDefaultBrowser(): void;
  /** Makes macOS ask again for screen recording (a relaunch is needed); false when it could not. */
  repairScreenSharing(): Promise<boolean>;
  openAdvanced(): void;
  /** The OrbStack install link: https only. */
  openUrl(url: string): void;
  /** macOS's System Settings › Notifications. */
  openNotificationSettings(): void;
  /** macOS's System Settings › Privacy & Security › Full Disk Access. */
  openFullDiskAccessSettings(): void;
  openFilesAndFoldersSettings(): void;
  /** Asks Firefox's updater now; the answer arrives in the state's `update`. */
  checkForUpdate(): void;
  /** Quits and reopens Ressac on the downloaded update. */
  restartToUpdate(): void;
  /** Opens the latest DMG, next to the update feed this build reads. */
  downloadUpdate(): void;
  /** Only in the document showing ressac://settings (design § 9.2): absent from the agent panel's API. */
  passport?: PassportSettingsApi;
}

/** A connection profile's passport as Réglages › Passeport lists it, without its values. */
export type PassportProfile = { id: string; name: string; count: number; state: "ok" | "unreadable" | "newer"; /** No space uses it: « Sans espace ». */ kept: boolean };
/**
 * Réglages › Passeport (design § 9.2), on the settings page's API only. Touch ID gives a token for one profile, valid
 * until `until` (5 minutes); reading and saving need it.
 */
export interface PassportSettingsApi {
  /** The spaces' profiles in sidebar order (none used only by private spaces), then passports kept without a space. */
  profiles(): Promise<PassportProfile[]>;
  /**
   * Touch ID « ouvrir votre passeport « {profil} » » (`delete`: « supprimer votre passeport », `move`: « déplacer votre
   * passeport », `restart`: « recréer votre passeport »); null when refused. `showMs`: how long « Voir » shows a
   * value. A delete, move or restart token serves once and never reads; the page keeps one token per purpose.
   */
  unlock(profile: string, purpose?: "open" | "delete" | "move" | "restart"): Promise<{ token: string; until: number; showMs: number } | null>;
  /** null: no live token for this profile, or the passport cannot be read. */
  read(profile: string, token: string): Promise<{ entries: PassportEntry[]; revision: string; dropped: number } | null>;
  /** `uncovered`: the open conversations now marked « non couverte ». `invalid`: an entry failed chrome's validation. */
  save(profile: string, token: string, entries: PassportEntry[], revision: string): Promise<{ ok: true; revision: string; uncovered: number } | { ok: false; error: "stale" | "write" | "newer" | "full" | "locked" | "invalid" }>;
  /** Revokes this page's tokens for that profile (only the `purpose` one when given). */
  lock(profile: string, purpose?: "open" | "delete" | "move" | "restart"): void;
  /** The Mac slept or its screen locked: every passport is locked again. */
  onLocked(callback: () => void): () => void;
  /** Deletes this profile's passport (its space goes, design § 4.4); false when the file could not be removed. */
  drop(profile: string): Promise<boolean>;
  /** « Supprimer ce passeport »: needs the token of an `unlock(profile, "delete")`; false when refused or not removed. */
  removePassport(profile: string, token: string): Promise<boolean>;
  /**
   * « Déplacer vers… » a kept passport, with the token of an `unlock(from, "move")`. `copied`: `to` has its entries but
   * `from` was not removed (it failed, or it changed since); `unread`: `from` holds entries this version cannot read;
   * `write`, `full`, `locked`: nothing changed.
   */
  moveTo(from: string, to: string, token: string): Promise<{ ok: true } | { ok: false; error: "locked" | "full" | "write" | "copied" | "unread" }>;
  /**
   * « Recommencer un passeport vide », with the token of an `unlock(profile, "restart")`: an unreadable passport's file
   * is kept aside and the profile starts empty; false when refused, not unreadable, or nothing moved.
   */
  restart(profile: string, token: string): Promise<boolean>;
}


export type ExtensionResult = { ok: true } | { ok: false; error: string };

/** An app as the page displays it: what the manager says, and what the browser kept of it. */
export type ApplicationShown = Application & { favicon?: string; lastLaunch?: string };
export interface ApplicationList {
  workshop: "ok" | "docker-absent";
  apps: ApplicationShown[];
}
/** A single path segment: no separator, no `.`/`..`, no NUL. */
const validSegment = (d: string) => d !== "" && d !== "." && d !== ".." && !/[/\\\0]/.test(d);
/** Possible actions on a « Sans fiche » project whose folder name cannot be launched (`My Project`, `_tmp`…). */
const WHOLE_FOLDER_ACTIONS = new Set(["debug", "delete", "folder"]);

export const SchemaActionApplication = z
  .object({
    folder: z.string(),
    action: z.enum(["launch", "stop", "relaunch", "open", "debug", "delete", "promote", "folder", "review"]),
  })
  .refine(({ folder, action }) => (WHOLE_FOLDER_ACTIONS.has(action) ? validSegment(folder) : validFolder(folder)));
export type ActionApplication = z.infer<typeof SchemaActionApplication>["action"];

/** An action on a site app: its id follows `ID_SITE` (never a path). */
export const SchemaActionSite = z.object({
  id: z.string().regex(ID_SITE),
  action: z.enum(["open", "close", "edit", "forget", "folder", "delete", "review"]),
});

/** A card of the ⌃Tab panel: `apercu` is a JPEG data URL, null if the tab was never captured. */
export interface TabsPanelCard {
  id: TabId;
  title: string;
  favicon: string | null;
  preview: string | null;
}
/** ⌃Tab panel: at most 7 cards (sliding window), `selection` is an index into `cartes`. */
export interface TabsPanel {
  cards: TabsPanelCard[];
  selection: number;
}
/** Messages from the ⌃Tab panel to the main process (Esc, click, hover, Tab on the UI's keyboard). */
export const WalkMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("confirm") }),
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("choose"), id }),
  z.object({ type: z.literal("hover"), id }),
  z.object({ type: z.literal("advance"), delta: z.union([z.literal(1), z.literal(-1)]) }),
]);
export type TabCycleMessage = z.infer<typeof WalkMessageSchema>;

/** What a window's agent panel says about masking (spec § 3, § 9 bis). */
export interface MaskingStatus {
  /** The workspace is locked since a reveal: the names of what was revealed (« votre code »), never the values. */
  locked: string[] | null;
  /** What the banner's sentence agrees with for those names (`one-m`, `one-f`, `other-m`, `other-f`). */
  lockedAgreement: string;
  /** The conversation was resumed from one started before masking, or by Codex: it may have seen the data in clear. */
  uncovered: boolean;
  /** Passport entries added after the conversation read something (design § 5.3): profile and id, never a value. */
  uncoveredPassport: { profile: string; id: string }[];
  /** The kernel's notice for this conversation (fill_field blocked after unknown labels), as it rendered it. */
  notice: string | null;
  /** An agent extension runs: it reads pages past the masker (Task 15). */
  extensionReads: boolean;
  /** The login profiles whose passport could not be read: their data is not masked (design § 4.5). */
  passportUnreadable: string[];
}

/** What a window's agent panel shows. */
export type AgentPanelState =
  | { state: "preparing"; step?: number; of?: number; label?: string; since?: number }
  | { state: "docker-absent" }
  | { state: "error"; message: string }
  | { state: "active"; engineChanged?: true }
  | { state: "done"; code: number }
  /** Stopped under memory pressure: the terminal keeps its screen, the next input resumes the conversation. */
  | { state: "asleep" }
  /** Instruction files changed since the last session: the session waits on the user's answer (agent.review). */
  | { state: "review"; id: number; files: InstructionChange[] };

const idWidget = z.string().regex(/^[a-z0-9-]+$/).max(100);
/** Id of an action (name of its folder under `~/Ressac/actions`). */
export const SchemaIdAction = z.string().regex(/^[a-z0-9-]{1,60}$/);
/** Input of an action coming from the UI: bounded here, cut by the kernel. */
export const ActionInputSchema = z.string().max(2000).nullable();
/** What the builder opens: a widget's workflow or an action's. */
export const TargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("widget"), id: idWidget }).strict(),
  z.object({ type: z.literal("action"), id: SchemaIdAction }).strict(),
]);

/**
 * Id of a block coming from the UI: bounded in size only (never a path). The engine validates the shape and names
 * the block at fault: an id written by the agent that it refuses must reach it.
 */
export const WorkflowBlockSchema = z.string().min(1).max(200);
/** Name of a widget code file: a `.mjs` at the root of its folder. */
export const NameCodeSchema = z.string().regex(/^[a-z0-9-]+\.mjs$/).max(64);
/** Text of a `.mjs`: 256 KB at most (in bytes, as on write). */
export const SchemaCodeWorkflow = z.string().max(256 * 1024).refine((t) => new TextEncoder().encode(t).length <= 256 * 1024, "code trop gros");
/**
 * Builder draft: bounded but not necessarily valid for the engine (`saveWorkflow` answers).
 * The parameters stay free: the engine validates them.
 */
export const DraftSchema = z.object({
  version: z.literal(1),
  blocks: z
    .array(
      z.object({
        id: WorkflowBlockSchema,
        type: z.string().min(1).max(200),
        name: z.string().max(200).optional(),
        position: z.object({ x: z.number().finite(), y: z.number().finite() }),
        params: z.record(z.string(), z.unknown()),
      }),
    )
    .max(100),
  links: z.array(z.object({ from: WorkflowBlockSchema, to: WorkflowBlockSchema })).max(400),
});

/** The block selected in a window's builder, and the workflow (widget or action) where it is. */
export type BuilderSelection = { widget: string; block: string | null } | { action: string; block: string | null };
/**
 * The block selected in the builder: an invalid block becomes « none » (`open_workflow` never shows
 * the old one); null, message ignored, if the target is invalid.
 */
export function builderSelection(v: unknown): BuilderSelection | null {
  const o = v as { target?: unknown; block?: unknown } | null;
  const target = TargetSchema.safeParse(o?.target);
  if (!target.success) return null;
  const r = WorkflowBlockSchema.safeParse(o?.block);
  const block = r.success ? r.data : null;
  return target.data.type === "widget" ? { widget: target.data.id, block: block } : { action: target.data.id, block: block };
}
export type Draft = z.infer<typeof DraftSchema>;

export type WorkflowEdit = DraftRead & {
  warnings: Warning[];
  /** What `widget.json` declares, read-only; `recolte` null: the widget declares none. Absent for an action. */
  widget?: {
    name: string;
    account: string[];
    public: string[];
    config: unknown;
    web: boolean;
    harvest: { minutes: number | null; hours: string[]; maxDurationMinutes: number | null; notify: boolean } | null;
  };
  /** What `action.json` declares, read-only (never written by Ressac). Absent for a widget. */
  action?: {
    name: string;
    account: string[];
    public: string[];
    web: boolean;
    input: { label: string } | null;
    layout: string | null;
    maxDurationMinutes: number | null;
  };
};
/** Id of an execution: its ISO start without « : » or « . » (never a path). */
export const SchemaIdExecution = z.string().regex(ID_EXECUTION).max(64);
const domain = z.string().min(1).max(253);
export const GrantSchema = z
  .object({ id: idWidget, profile: z.string().min(1).max(200), account: z.array(domain).max(100), public: z.array(domain).max(100) })
  .strict();
export type Grant = z.infer<typeof GrantSchema>;
export const ReadsApprovalSchema = z.object({ id: idWidget, public: z.array(domain).max(100), web: z.boolean() }).strict();
export type ReadsApproval = z.infer<typeof ReadsApprovalSchema>;
export const TerminalSizeSchema = z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000) });
export type TerminalSize = z.infer<typeof TerminalSizeSchema>;

/** Place of a widget in the 12-column grid (rows of 90 px). */
export interface Placement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A home page widget, as the UI displays it. */
export type ShownWidget =
  | {
      id: string;
      name: string;
      placement: Placement;
      sizes: DeclarationWidget["sizes"];
      /** `ressac-widget://<id>/display.html?v=<mtime>`, or null until the agent has written the display. */
      src: string | null;
      data: unknown | null;
      example: unknown | null;
      state: WidgetState;
      /** Domains read with the user's account (empty: public sources only). */
      account: string[];
      /** Public domains the widget may contact; for a widget with an account, covered by the same grant. */
      public: string[];
      /** The widget searches and reads the web (never with an account). */
      web: boolean;
      /** The widget has a harvest (`workflow.json` or `harvest.mjs`): its menu offers « Voir / modifier le workflow ». */
      hasHarvest: boolean;
      /** Fixed times of the harvest (« HH:MM »), empty without them. */
      hours: string[];
      /** Harvest frequency in minutes, null without it. */
      minutes: number | null;
    }
  | { id: string; error: string; placement: Placement };

export interface ProfileForGrant {
  id: string;
  /** « Profil de « Perso, Travail » »: the spaces that use it. */
  label: string;
  /** The profile of the window's active space, if it can be used. */
  isDefault: boolean;
}

/** State of the local AI for the indicator; `verification`: what is in place (absent if not checked). */
export interface LocalAiStateShown {
  state: AiState;
  error?: string;
  verification?: { decision: boolean; embed: boolean };
  /** The last failed download of the decision model, until one succeeds (retried at the next launch). */
  decisionError?: string;
  /** Same for the search model. */
  searchError?: string;
  /** The search model's server failed to start (`error` is the decision server's). */
  searchServerError?: string;
}

/** What an app window's badge UI gets (ui/badge-api.ts): the agent's access and its app's design mode. */
export type BadgeApi = Pick<ApiRessac, "access" | "onAccess"> & {
  /** Asks the main process to enlarge (bubble open) or shrink the badge's view. */
  badgeSize(opened: boolean): void;
  /** The language shown (the badge frame has no browser state). */
  locale(): string;
  /** The design mode of the app window; « Panier » opens it in the window's overlay. */
  design: { state(): Promise<DesignState>; toggle(): void; basket(): void; review(): void };
};

/**
 * The single API of a site app window's UI (`site.html`). The main process recognizes the app by
 * the sender, never by what the UI says.
 */
export interface ApiSite {
  state(): Promise<SiteWindowState | null>;
  onState(callback: (e: SiteWindowState) => void): () => void;
  /** « Entrer dans le site »: the site view, loaded on the start address the first time only. */
  enter(): void;
  /** ⌂: back to the home screen, the site page stays loaded underneath. */
  home(): void;
  previous(): void;
  next(): void;
  reload(): void;
  /** « Ouvrir dans un onglet »: the last blocked link, in a tab of the main window. */
  openBlocked(): void;
  /** « Chercher la nouvelle adresse »: reads the reference page (at most once a minute); no effect if the app has none. */
  lookupAddress(): void;
  /**
   * The tweaks grant card. yes: the grant is kept, then the next view (home or site) with tweaks;
   * no: the next view without tweaks or resume, for this opening only (the card comes back at the next one).
   * `empreinte`: that of the clicked card; if the rights changed since, nothing is granted and the card comes back up to date.
   */
  grant(yes: boolean, hash: string): Promise<void>;
  /** For the home screen: the app's memory and its resume positions (read), and the current domain. */
  memory(): Promise<MessageToHome & { type: "memory" }>;
  /** Each change of the app's memory; returns the unsubscribe. */
  onMemory(callback: (m: MessageToHome & { type: "memory" }) => void): () => void;
  /**
   * The home asks for a site address (relative or on one of its domains): the site view goes there, on the
   * current domain. False if it is refused, or if another was just opened (one per `HOME_OPEN_GAP_MS`).
   */
  open(url: string): Promise<boolean>;
  /** An image of an app domain, loaded with its session, as `data:`; null if it is refused. */
  image(url: string): Promise<string | null>;
  /** The bar's « Extensions » menu (plan 16): the Store extensions, enabled for this app only. */
  extensions: {
    /** The Store extensions, and their state in this app. */
    list(): Promise<SiteExtensionLine[]>;
    /** The switch: the site view is reloaded after a success (the already loaded page only). */
    toggle(key: string, active: boolean): Promise<ExtensionResult>;
    /** Partition `persist:site-<id>`, tab = id of the view in « site » view (otherwise null), and the loaded extensions. */
    bar(): Promise<ExtensionsBar>;
    /** `CANAUX.extensionsChange`; returns the unsubscribe. */
    onChange(callback: () => void): () => void;
    /** The Extensions page, in a main window. */
    manage(): void;
    /** Height of the open menu panel under the bar (0: closed), bounded by `EXTENSIONS_PANEL_MAX`. */
    panel(height: number): void;
    /** The main process asks to close the menu (click in the site view, fullscreen); returns the unsubscribe. */
    onClose(callback: () => void): () => void;
  };
  /**
   * The app's design mode (plan 18), ✎ button and chevron of the bar: the main process recognizes the app by
   * the sender. `surChange` only listens to `CANAUX.designChange` (the counter follows), without any action.
   */
  design: {
    state(): Promise<DesignState>;
    toggle(): void;
    review(): void;
    openBasket(): void;
    onChange(callback: () => void): () => void;
  };
}

/** The design mode of a target (a window's active tab, or an app window). */
export interface DesignState {
  active: boolean;
  project: TrackedProject | null;
  /** Reason why design mode is not offered here; null if it is. */
  unavailable: string | null;
  /** « l'agent », « Claude Code (<nom>) »; null if nobody can receive the notes. */
  destination: string | null;
  /** Why `destination` is null (no Claude Code connected). */
  noDestination: string | null;
  /** Number of notes in the project's basket. */
  basket: number;
  /** Name of the project to display. */
  name: string;
  /** The mode's current key, e.g. « ⇧⌘D » (windows without settings in their state read it here). */
  shortcut: string;
}
/** A note as the basket and the history display it: text, never HTML. */
export interface ShownElement {
  id: string;
  type: "design" | "review";
  label: string;
  text: string;
  source: string | null;
  handled: { when: string; note?: string } | null;
}
export interface BatchShown {
  id: string;
  created: string;
  state: BatchState;
  destination: "agent" | "mcp";
  items: ShownElement[];
}
export interface ApiDesign {
  state(): Promise<DesignState>;
  /** ⌘⇧D: no effect where the mode is unavailable. */
  toggle(): void;
  basket(project: ProjectId): Promise<ShownElement[]>;
  remove(project: ProjectId, id: string): Promise<void>;
  send(project: ProjectId): Promise<ExtensionResult>;
  batches(project: ProjectId): Promise<BatchShown[]>;
  handled(project: ProjectId, batch: string): Promise<void>;
  /** « Relire ce projet » (`app` and `externe` projects). */
  review(): void;
  onChange(callback: () => void): () => void;
}
/** What the overlay shows: a note's bubble (targeted element) or an app window's basket. */
export interface OverlayContext {
  /** « message »: why ⌘⇧D does nothing in the tab (empty project, never a basket). */
  mode: "bubble" | "basket" | "message";
  /** The text of the « message » mode; null elsewhere. */
  message: string | null;
  project: ProjectId;
  label: string;
  source: string | null;
  destination: string | null;
  noDestination: string | null;
  /** Bubble of a site app: what will go to the agent (excerpt, capture); null elsewhere. */
  warning: string | null;
  /** The language the overlay's own texts are shown in (the overlay frame has no browser state). */
  locale: string;
}
/** The single API of the design mode overlay (`design.html`); the main process recognizes its target by the sender. */
export type OverlayApi = {
  context(): Promise<OverlayContext | null>;
  add(text: string): Promise<ExtensionResult>;
  /** Esc or « Annuler » in the bubble; « Fermer » of the basket. */
  cancel(): void;
} & Pick<ApiDesign, "basket" | "remove" | "send" | "batches" | "handled" | "onChange">;
/** A rect in the hide layer frame's CSS px (its origin is the page's top left corner). */
export type HideRect = { x: number; y: number; width: number; height: number };
/**
 * « Cacher pour l'agent » (chrome/window/hide-layer.ts), what both of its frames show: the layer (outline, animation,
 * ending) and the bubble frame (bubble, error, toast). The frozen text is the chrome's; the frames only show it.
 */
export interface HideContext {
  /** pick: the viewfinder is armed; bubble: the confirmation; saving: Touch ID and the write; toast: saved. */
  phase: "pick" | "bubble" | "saving" | "toast" | "error";
  /** The text frozen at the pick (what is saved), and its start…end over 60 characters. */
  text: string;
  short: string;
  /** « Sur {site} et vos autres sources »; null: no site is added (an agent-reached tab, a page without a host). */
  site: string | null;
  field: PassportField;
  name?: { given: string; family: string };
  ending?: "hidden" | "next" | "agentReached";
  /** The toast's « Annuler »: false when the hide wrote nothing (the value was already there, with this site). */
  undoable?: boolean;
  /** The tab's conversation had already read this page: the toast says so. */
  readBefore?: boolean;
  /** invalid: the text does not fit the chosen type (the bubble stays open). */
  error?: "long" | "write" | "unreadable" | "full" | "invalid";
  hover?: HideRect;
  target?: HideRect;
  /** The target's pixels at the pick (data: URL), and the page colour behind it, for the animation. */
  snapshot?: { url: string; background: string };
  /** The ending's label chip, `⟨nom-…⟩`. */
  chip?: string;
  /** Changes at each hide: the layer plays its animation once per value. */
  seq: number;
  locale: string;
}
/** What the hide frames may do: the gesture's endpoints only, never a raw hide or unhide. */
export type HideApi = {
  context(): HideContext | null;
  confirm(choice: { field: PassportField; name?: { given: string; family: string } }): Promise<void>;
  cancel(): void;
  undo(): Promise<void>;
  onChange(cb: () => void): () => void;
};
/** Text of a note: bounded at the entry of the main process. */
export const REMARK_TEXT_MAX = 4000;

/** « Projets externes » section of the Applications page: the external MCP, its projects and its clients (never a token). */
export interface ExternalsState {
  server: { state: "ready"; port: number } | { state: "off"; reason: string };
  projects: (ExternalProject & { client: string | null; clientName: string | null })[];
  clients: { id: string; name: string; created: string }[];
}
export interface ExternalApi {
  list(): Promise<ExternalsState>;
  /** The command to copy into Claude Code's terminal: the token appears there only once. */
  connect(name: string): Promise<{ command: string }>;
  revoke(id: string): Promise<void>;
  forget(id: string): Promise<void>;
  /** « Relire »: the project's review page. */
  review(id: string): void;
  onChange(callback: () => void): () => void;
}

/** Review page: what it shows of a project (the diff since the last review), or why it cannot. */
export type ReviewView =
  | {
      state: "ok"; name: string; token: string; comparison: { files: ModifiedFile[] }; comments: Comment[];
      /** Who the comments go to (« l'agent », « Claude Code (…) »); otherwise why they cannot be sent. */
      destination: string | null; noDestination: string | null;
    }
  | { state: "unavailable"; name: string; reason: string };
export type { DiffFile, ModifiedFile, Comment as DiffComment, ChangedFile, LiftChoice, QuarantinedFile };
export interface ReviewApi {
  /**
   * Compares the project to its last review and returns the token of that comparison (kept by the main process).
   * With the token of a comparison still kept: that one, without comparing again; « Rafraîchir » does not pass one.
   */
  open(project: ProjectId, token?: string): Promise<ReviewView>;
  /** The diff of one file of the token's comparison (never another path); a token no longer kept is refused. */
  file(project: ProjectId, token: string, path: string): Promise<DiffFile>;
  /** Lines `start`..`end` (from 1) of the current version of a file of the token's comparison. */
  lines(project: ProjectId, token: string, path: string, start: number, end: number): Promise<string[]>;
  /** The project's comments, as saved. */
  comments(project: ProjectId): Promise<Comment[]>;
  /** A comment on lines of a single block of the token's diff; the lines are read by the main process. */
  comment(project: ProjectId, token: string, c: { file: string; start: number; end: number; text: string }): Promise<ExtensionResult>;
  editComment(project: ProjectId, id: string, text: string): Promise<void>;
  resolve(project: ProjectId, id: string, resolved: boolean): Promise<void>;
  deleteComment(project: ProjectId, id: string): Promise<void>;
  /** Unresolved comments go out as one batch (agent: pre-filled, never sent; external: MCP queue). */
  send(project: ProjectId): Promise<ExtensionResult>;
  /** « Marquer comme relu »: keeps the tree shown by the token's comparison, then returns a new comparison. */
  reviewed(project: ProjectId, token: string): Promise<ReviewView>;
}
