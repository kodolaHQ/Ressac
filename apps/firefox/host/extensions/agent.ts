import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  enable,
  parseManifest,
  applyPrivateProfiles,
  extensionKey,
  cutAll,
  REQUEST_REMOVED,
  disable,
  disableEverywhere,
  PRIVATE_PROFILE_ERROR,
  DEFAULT_GUARDS,
  scopeLabels,
  readExtensionsState,
  changeExtensionsState,
  widenedScope,
  prepareCopy,
  remove,
  type ManifestAnalysis,
  type AgentConsole,
  type ExtensionEntry,
  type ExtensionsState,
  type AgentExtension,
  type MessageConsole,
  type ExtensionsTools,
  type Scope,
  type ExtensionConsoleResult,
  type ExtensionRequestResult,
} from "../../../../packages/kernel/src/index.ts";
import type { ExtensionCard, ExtensionLine, SpaceExtensionLine, GrantResponse } from "../../shared/extensions.ts";
import type { ExtensionResult } from "../../shared/api.ts";
import { DISABLED_CRASHES, DISABLED_SCOPE, UNLOCK_REASON_LENGTH } from "../../shared/extensions-messages.ts";
import type { Space, Outcome } from "../../shared/model.ts";
import { ConsolesExtensions, type AgentFilter } from "../../core/extensions/consoles.ts";
import type { Rpc } from "../../shared/rpc.ts";
import { AMO_URL, KEYS_ABSENT, SignatureError, readAmoKey, signatureImpossible, sign } from "./amo.ts";
import { cardOf, unsupported } from "./card.ts";
import { addonIdOf, firefoxManifest, nextVersion, firefoxDenial, ID_SUFFIX, zipper } from "./firefox-copy.ts";

export const FOLDER_ABSENT = "Dossier absent";
export const ACTIVATION_DENIED = "Activation refusée";
export const ACTIVATION_REMOVED = REQUEST_REMOVED;
export const ALL_CUT_AGENT = "Les extensions sont toutes désactivées : rien n'est activé";
const REMOVED_DURING_CARD = "Extension retirée pendant la carte : rien n'est activé";
const SPACE_GONE = "Espace disparu pendant la carte : rien n'est activé";
export const folderAbsent = (id: string) => `${FOLDER_ABSENT} : ~/Ressac/extensions/${id} n'existe plus (recrée-le, puis reload_extension)`;
export const NO_GRANT = "Extension sans accord : demande d'abord son activation";
/** Firefox refused the signed .xpi. */
export const installationImpossible = (m: string) => "Installation impossible : " + m.slice(0, 2000);

export const CONSOLE_PRIVATE_PROFILE = "Extension active dans le profil d'un espace privé : sa console n'est jamais montrée à l'agent";
export const UNLOCK_INACTIVE = "Extension inactive ou désactivée : rien à débloquer (demande d'abord son activation)";
export const UNLOCK_CHANGED = "L'extension a changé pendant la carte : rien n'est débloqué";
const UNLOCK_DENIED = "Déblocage refusé";
export const REVIEW_DURING_OUTAGE = "Les extensions sont toutes désactivées : réactivez-les pour revoir cette extension";
export const NOTHING_TO_REVIEW = "Rien à revoir pour cette extension";
const PAGE_CONSOLE_ERRORS = 20;
/** Rights that see tabs or navigation: with one, sites or all sites, the background's and pages' console stays masked. */
export const OBSERVER_RIGHTS = ["tabs", "webNavigation", "cookies", "history", "topSites", "sessions", "bookmarks", "activeTab", "clipboardRead", "contextMenus",
  "declarativeNetRequestFeedback"];
const LEVELS: readonly string[] = ["log", "info", "warn", "error", "debug"] satisfies MessageConsole["level"][];

/** What the unlock card showed: the unlock holds only for that. */
interface UnlockLink {
  /** The profiles where it was active: active in another one ends it. */
  profiles: string[];
  /** `modifieeLe`: a new copy (reloaded, recreated) ends it. */
  mark: string | null;
}

export type SendResult = { ok: true; analysis: ManifestAnalysis } | { ok: false; error: string; denial?: string[] };

type Preparation = { ok: true; analysis: ManifestAnalysis; hash: string; staging: string; originalBackground: string | undefined };

interface Marker {
  path: string;
  dev: number;
  ino: number;
}

/** Every element from the agent's extensions folder to `<id>` is a real directory (lstat), never a symbolic link. */
async function pathMarkers(agentFolder: string, id: string): Promise<Marker[] | string> {
  const markers: Marker[] = [];
  for (const path of [agentFolder, join(agentFolder, id)]) {
    let info;
    try {
      info = await lstat(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return FOLDER_ABSENT;
      return `Dossier illisible : ${(e as Error).message}`;
    }
    if (info.isSymbolicLink()) return `Lien symbolique refusé : ${path}`;
    if (!info.isDirectory()) return path === agentFolder ? FOLDER_ABSENT : `Pas un dossier : ${path}`;
    markers.push({ path: path, dev: info.dev, ino: info.ino });
  }
  return markers;
}

/** What Firefox answers to navigateur.espaces. */
interface Browser {
  spaces: Space[];
  windows: { id: string; activeSpace: string }[];
  foreground: string | null;
}
const privateProfilesOf = (n: Browser) => new Set(n.spaces.filter((e) => e.private).map((e) => e.profile));

const sameMarkers = (a: Marker[], b: Marker[]) =>
  a.length === b.length && a.every((x, i) => x.path === b[i]!.path && x.dev === b[i]!.dev && x.ino === b[i]!.ino);

/** Why the console of `cle` cannot (or no longer) be unlocked, or null. */
function unlockDenial(e: ExtensionsState, privates: ReadonlySet<string>, key: string): string | null {
  const x = e.extensions[key];
  if (!x || x.source !== "agent") return `Extension inconnue : ${key}`;
  if (x.profiles.some((p) => privates.has(p))) return CONSOLE_PRIVATE_PROFILE;
  if (e.allCut || x.disabled || x.profiles.length === 0) return UNLOCK_INACTIVE;
  return null;
}

/** True if `cle` is no longer what the card showed: a new copy, or active in another profile (the add-on id never changes here). */
function brokenLink(e: ExtensionsState, key: string, link: UnlockLink): boolean {
  const x = e.extensions[key];
  return !x || x.modifiedAt !== link.mark || x.profiles.some((p) => !link.profiles.includes(p));
}

/** Decision 4: installed but disabled unless granted, active in a profile, not disabled, and not everything cut. */
const activeIn = (e: ExtensionsState, x: ExtensionEntry | undefined) => !!x?.grant && x.profiles.length > 0 && !x.disabled && !e.allCut;

/** What the chrome's guard checkpoints read (`extensions.scopes`): each granted agent extension by its add-on id. */
export type Scopes = Record<string, { key: string; grant: Scope; profiles: string[]; active: boolean }>;
export function scopesOf(e: ExtensionsState): Scopes {
  const r: Scopes = {};
  for (const [key, x] of Object.entries(e.extensions))
    if (x.source === "agent" && x.grant) r[addonIdOf(key.slice("agent:".length))] = { key: key, grant: x.grant, profiles: x.profiles, active: activeIn(e, x) };
  return r;
}

/**
 * The agent's extensions (registry `<dossier>/state.json`, copies, signed .xpi), kept in the kernel host; the chrome
 * installs, enables, disables or uninstalls by RPC. One operation at a time per extension.
 */
export class ExtensionsAgent {
  private readonly files = new Map<string, Promise<unknown>>();
  /** The grant card open for each key: a reload or a removal takes it down (it holds the key's queue). */
  private readonly cards = new Map<string, AbortController>();
  private readonly stopSignal = new AbortController();
  private readonly env: NodeJS.ProcessEnv;
  /** The agent's extensions' consoles and crash counts, by add-on id, in memory. */
  private readonly consoles = new ConsolesExtensions({
    onCrashes: (addonId) => void this.disableCrashes(addonId).catch((e: unknown) => console.error(`[extensions] ${addonId} not disabled after its crashes :`, e)),
  });
  /** Consoles unlocked for the agent, by key: in memory only (quitting ends them). */
  private readonly unlocks = new Map<string, UnlockLink>();
  /** The last refused startup or reload of each key, shown until one passes. */
  private readonly sendErrors = new Map<string, string>();
  /** Unlock cards shown, by key: one at a time, taken down if the extension leaves the registry or changes. */
  private readonly unlockCards = new Map<string, { answer: Promise<Outcome>; removal: AbortController; link: UnlockLink; waits: number }>();
  /** Keys whose source changed while closed and that ran nowhere at startup: signed when next activated (appliquer). */
  private readonly toSign = new Set<string>();

  constructor(private readonly o: { folder: string; agentFolder: string; rpc: Rpc; env?: NodeJS.ProcessEnv }) {
    this.env = o.env ?? process.env;
  }

  /** Startup (decision 5): leftovers deleted, every granted one recopied, signed again only if its source changed, then installed. */
  async start(): Promise<void> {
    // First: the chrome's checkpoints wait for it (an add-on kept by Firefox starts before this host).
    this.o.rpc.notify("extensions.scopes", scopesOf(await readExtensionsState(this.o.folder)));
    for (const [sub, rest] of [
      ["copies", /\.(tmp|ancienne|pending)$/],
      ["signed", /\.(pending|upload)\.xpi$/],
    ] as const) {
      const names = await readdir(join(this.o.folder, sub)).catch(() => [] as string[]);
      for (const name of names) if (rest.test(name)) await rm(join(this.o.folder, sub, name), { recursive: true, force: true }).catch(() => undefined);
    }
    const state = await readExtensionsState(this.o.folder);
    await Promise.all(
      Object.entries(state.extensions).map(async ([key, x]) => {
        if (x.source !== "agent" || !x.grant) return;
        try {
          const r = await this.prepareAndInstall(key.slice("agent:".length), { grant: x.grant, startup: true });
          if (!r.ok) console.warn(`[extensions] ${key} at startup: ${r.error}`);
        } catch (e) {
          console.error(`[extensions] ${key} not installed at startup:`, e);
        }
      }),
    );
  }

  /**
   * Copy, sign, install. The scope must stay within `grant` (broadened: disabled, grant kept). `demarrage`: an unchanged
   * source reinstalls the kept signed .xpi without sending anything. A failure before the install leaves the registry
   * and the running version untouched.
   */
  prepareAndInstall(id: string, o: { grant: Scope; startup?: boolean }): Promise<SendResult> {
    const key = this.key(id);
    if (!key) return Promise.resolve({ ok: false, error: `Identifiant d'extension invalide : ${id}` });
    return this.queued(key, () => this.send(id, key, o).then((r) => this.noteSend(key, r)));
  }

  /** Keeps a refused copy, signing or install as the key's error; a success or a disabling clears it. */
  private noteSend<T extends SendResult>(key: string, r: T): T {
    const before = this.sendErrors.get(key);
    if (r.ok || r.error === DISABLED_SCOPE) this.sendErrors.delete(key);
    else this.sendErrors.set(key, r.error);
    if (before !== this.sendErrors.get(key)) this.o.rpc.notify("extensions.change");
    return r;
  }

  /** The agent's extension tools. */
  tools(): ExtensionsTools {
    return {
      list: () => this.list(),
      ask: (id, x) => this.ask(id, x),
      reload: (id) => this.reload(id),
      console: (id, from) => this.consoleForAgent(id, from),
      unlockConsole: (id, reason, x) => this.unlockConsole(id, reason, x),
      closeConsoleAgain: async (id) => {
        const key = this.agentKey(id);
        if (!key) return { ok: false, error: `Extension inconnue : ${id}` };
        return this.cutUnlock(key);
      },
    };
  }

  /** A console message the chrome relayed (`extensions.console`); `onglet`: a content script's, readable by the agent or not. */
  noteConsole(addonId: unknown, m: unknown, tab: unknown): void {
    const x = m as Partial<MessageConsole> | null;
    if (typeof addonId !== "string" || !addonId.endsWith(ID_SUFFIX) || !this.key(addonId.slice(0, -ID_SUFFIX.length))) return;
    if (!x || typeof x.timestamp !== "number" || typeof x.text !== "string" || !LEVELS.includes(x.level as string)) return;
    const o = tab as { readable?: unknown } | null;
    this.consoles.note(addonId, { timestamp: x.timestamp, level: x.level!, text: x.text }, o ? { readable: o.readable === true } : undefined);
  }

  /** A crash the chrome saw (`extensions.crash`, or queued in `extensions.ready`; spike S7): the `PLANTAGES_MAX`-th in `FENETRE_PLANTAGES_MS` disables it everywhere. */
  crash(addonId: unknown, at?: unknown): void {
    if (typeof addonId !== "string" || !addonId.endsWith(ID_SUFFIX) || !this.key(addonId.slice(0, -ID_SUFFIX.length))) return;
    // When the chrome saw it (a crash queued while no host ran), never later than now.
    const now = Date.now();
    this.consoles.crash(addonId, typeof at === "number" && at <= now ? at : now);
  }

  /** Disabled everywhere after crashes (`DISABLED_CRASHES`), shown on the page with « Réactiver ». */
  private async disableCrashes(addonId: string): Promise<void> {
    const key = this.key(addonId.slice(0, -ID_SUFFIX.length))!;
    const r = await this.writeKey(key, (e) => {
      const x = e.extensions[key]!;
      return x.disabled ? e : { ...e, extensions: { ...e.extensions, [key]: { ...x, disabled: { reason: "crashes" as const, at: new Date().toISOString() } } } };
    });
    if (!r.ok) throw new Error(r.error);
    console.warn(`[extensions] ${key} disabled: ${DISABLED_CRASHES}`);
  }

  /** `extension_console`: filtered (unlocked: whole); null if not in the registry. */
  private async consoleForAgent(id: string, from?: number): Promise<AgentConsole | null> {
    const key = this.agentKey(id);
    const state = await readExtensionsState(this.o.folder);
    const x = key ? state.extensions[key] : undefined;
    if (!key || !x) return null;
    const privates = privateProfilesOf(await this.browser());
    if (x.profiles.some((p) => privates.has(p))) throw new Error(CONSOLE_PRIVATE_PROFILE);
    return this.consoles.forAgent(addonIdOf(this.id(key)!), this.agentFilter(state, key, from));
  }

  /** The console filter: unlocked; ran in an unreadable tab (entry flag, or its add-on id kept after a removal); observing right. */
  private agentFilter(state: ExtensionsState, key: string, from?: number): AgentFilter {
    const x = state.extensions[key];
    const a = x?.grant;
    return {
      ...(from !== undefined ? { since: from } : {}),
      unlocked: this.unlocks.has(key),
      unreadableRunning: (x?.hiddenConsole?.length ?? 0) > 0 || !!state.hiddenConsoles?.includes(addonIdOf(this.id(key)!)),
      observer: !a || a.allSites || a.allSitesScripts || a.hosts.length > 0 || a.permissions.some((p) => OBSERVER_RIGHTS.includes(p)),
    };
  }

  /**
   * `unlock_console`: the unlock card, for an agent extension active somewhere, never
   * in a private space's profile, naming the spaces of its profiles. Granted: its console is whole for what the card
   * showed, until lock_console or a registry write that ends it (verifierDeblocages).
   */
  private async unlockConsole(id: string, reason: string, x: { window: string | null; agent: string; signal?: AbortSignal }): Promise<ExtensionConsoleResult> {
    const key = this.agentKey(id);
    const state = await readExtensionsState(this.o.folder);
    const entry = key ? state.extensions[key] : undefined;
    if (!key || !entry) return { ok: false, error: `Extension inconnue : ${id}` };
    const nav = await this.browser();
    const denial = unlockDenial(state, privateProfilesOf(nav), key);
    if (denial) return { ok: false, error: denial };
    if (this.unlocks.has(key)) return { ok: true };
    let card = this.unlockCards.get(key);
    if (!card) {
      const removal = new AbortController();
      const link = { profiles: [...entry.profiles], mark: entry.modifiedAt };
      const request = {
        name: entry.name,
        spaces: nav.spaces.filter((e) => link.profiles.includes(e.profile) && !e.private).map((e) => e.name),
        reason: reason.slice(0, UNLOCK_REASON_LENGTH),
        agent: x.agent,
        window: x.window,
      };
      const fresh = {
        removal: removal,
        link: link,
        waits: 0,
        answer: this.o.rpc
          .request<Outcome>("extensions.unlock", request, AbortSignal.any([removal.signal, this.stopSignal.signal]))
          .catch((): Outcome => "withdrawn")
          .finally(() => {
            if (this.unlockCards.get(key) === fresh) this.unlockCards.delete(key);
          }),
      };
      this.unlockCards.set(key, fresh);
      card = fresh;
    }
    const opened = card;
    opened.waits++;
    // This call dropped (new conversation) takes the card down only if it is the last one waiting for it.
    let giveUp: () => void = () => {};
    const abandon = new Promise<Outcome>((ok) => (giveUp = () => ok("withdrawn")));
    let gone = false;
    const from = () => {
      if (gone) return;
      gone = true;
      if (--opened.waits === 0) opened.removal.abort();
      giveUp();
    };
    if (x.signal?.aborted) from();
    x.signal?.addEventListener("abort", from, { once: true });
    let outcome: Outcome;
    try {
      outcome = await Promise.race([opened.answer, abandon]);
    } finally {
      x.signal?.removeEventListener("abort", from);
      if (!gone) {
        gone = true;
        opened.waits--;
      }
    }
    if (outcome === "withdrawn") return { ok: false, error: REQUEST_REMOVED, removed: true };
    if (outcome !== "allow") return { ok: false, error: UNLOCK_DENIED, denied: true };
    // The state may have changed during the card: checked again on « yes », against what the card showed.
    const after = await readExtensionsState(this.o.folder);
    if (unlockDenial(after, privateProfilesOf(await this.browser()), key) || brokenLink(after, key, opened.link)) return { ok: false, error: UNLOCK_CHANGED };
    this.unlocks.set(key, opened.link);
    this.o.rpc.notify("extensions.change");
    return { ok: true };
  }

  /** « Couper le déblocage » (Extensions page) or `lock_console`: its console is filtered again. */
  cutUnlock(key: string): ExtensionResult {
    if (this.unlocks.delete(key)) this.o.rpc.notify("extensions.change");
    return { ok: true };
  }

  /** After each registry write: an unlock whose extension left, was disabled, cut, activated elsewhere or recopied ends; its card falls. */
  private checkUnlocks(e: ExtensionsState, privates: ReadonlySet<string>): void {
    for (const [key, link] of [...this.unlocks]) if (unlockDenial(e, privates, key) || brokenLink(e, key, link)) this.unlocks.delete(key);
    for (const [key, card] of this.unlockCards) if (unlockDenial(e, privates, key) || brokenLink(e, key, card.link)) card.removal.abort();
  }

  /** `<id>` or `agent:<id>`. */
  private agentKey(id: string): string | null {
    return this.key(id.startsWith("agent:") ? id.slice("agent:".length) : id);
  }

  /**
   * Each registry entry: the non-private spaces where it is active (named), the private ones (counted), its disabling;
   * then Firefox's AMO add-ons (decision 7): global, so active in every space, with no error.
   */
  private async list(): Promise<AgentExtension[]> {
    const [nav, state, amo] = await Promise.all([
      this.browser(),
      readExtensionsState(this.o.folder),
      // An extra source: the agent keeps its own rows if Firefox cannot list its add-ons.
      this.o.rpc.request<{ id: string; name: string; version: string; active: boolean }[]>("extensions.amo", {}).catch((e: unknown) => {
        console.error("[extensions] AMO add-ons not listed:", e);
        return [];
      }),
    ]);
    const privates = nav.spaces.filter((e) => e.private).length;
    const opened = nav.spaces.filter((e) => !e.private).map((e) => e.name);
    const modules = amo
      .map((a): AgentExtension => ({ key: `store:${a.id}`, source: "store", name: a.name, version: a.version, spaces: a.active ? opened : [], privateSpaces: a.active ? privates : 0, errors: [] }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
    const privateProfiles = privateProfilesOf(nav);
    const agent = Object.entries(state.extensions)
      .map(([key, x]): AgentExtension => {
        const spaces = nav.spaces.filter((e) => x.profiles.includes(e.profile));
        const id = this.id(key);
        // Its kept error, its disabling, then its console's errors as extension_console filters them.
        const errors = [...(this.sendErrors.has(key) ? [this.sendErrors.get(key)!] : []), ...(x.disabled ? [x.disabled.reason === "crashes" ? DISABLED_CRASHES : DISABLED_SCOPE] : [])];
        if (id && !x.profiles.some((p) => privateProfiles.has(p))) errors.push(...this.consoles.errorsForAgent(addonIdOf(id), this.agentFilter(state, key)).slice(-PAGE_CONSOLE_ERRORS));
        return {
          key: key,
          source: x.source,
          name: x.name,
          version: x.version,
          spaces: spaces.filter((e) => !e.private).map((e) => e.name),
          privateSpaces: spaces.filter((e) => e.private).length,
          errors: errors,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
    return [...agent, ...modules];
  }

  /** The Extensions page (the agent's only): one row per registry entry, by name. */
  async entries(): Promise<ExtensionLine[]> {
    const [nav, state] = await Promise.all([this.browser(), readExtensionsState(this.o.folder)]);
    const privates = privateProfilesOf(nav);
    const lines: ExtensionLine[] = [];
    for (const [key, x] of Object.entries(state.extensions)) {
      const id = this.id(key);
      if (!id || x.source !== "agent") continue;
      const manifest = await readFile(join(this.o.folder, "copies", id, "manifest.json"), "utf8").then((t) => JSON.parse(t) as unknown, () => null);
      // The granted scope; without a grant (never for a loaded entry), the manifest's on disk.
      const scope = x.grant ?? parseManifest(manifest, { source: "agent" }).scope;
      const disabled = x.disabled ? (x.disabled.reason === "crashes" ? DISABLED_CRASHES : DISABLED_SCOPE) : null;
      lines.push({
        key: key,
        name: x.name,
        source: "agent",
        version: x.version,
        rights: scopeLabels(scope, "agent"),
        sites: [...scope.hosts],
        allSites: scope.allSites,
        spaces: nav.spaces.filter((e) => x.profiles.includes(e.profile) && !privates.has(e.profile)).map((e) => ({ name: e.name, profile: e.profile })),
        errors: [...(this.sendErrors.has(key) ? [this.sendErrors.get(key)!] : []), ...this.consoles.errors(addonIdOf(id)).slice(-PAGE_CONSOLE_ERRORS)],
        modifiedAt: x.modifiedAt,
        disabled: disabled,
        pendingUpdate: null,
        unsupported: unsupported(manifest),
        pinned: x.pinned,
        consoleUnlocked: this.unlocks.has(key),
        siteApps: [],
      });
    }
    return lines.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  }

  /** « Désactiver toutes les extensions » is on. */
  async cut(): Promise<boolean> {
    return (await readExtensionsState(this.o.folder)).allCut;
  }

  /** « Désactiver toutes les extensions » (kept in the registry, so across a restart): every agent add-on disabled, never uninstalled. */
  async cutAll(yes: boolean): Promise<ExtensionResult> {
    try {
      const e = await this.edit((e) => cutAll(e, yes));
      for (const key of Object.keys(e.extensions)) {
        const id = this.id(key);
        if (id) await this.queued(key, () => this.apply(id, key));
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** « Désactiver partout »: out of every profile, the add-on disabled; its grant and storage stay (decision 4). */
  disableEverywhere(key: string): Promise<ExtensionResult> {
    return this.writeKey(key, (e) => disableEverywhere(e, key));
  }

  /** « Réactiver » after crashes: it runs again in the profiles where it was active. */
  async reactivate(key: string): Promise<ExtensionResult> {
    const r = await this.writeKey(key, (e) => {
      const x = e.extensions[key]!;
      return x.disabled?.reason === "crashes" ? { ...e, extensions: { ...e.extensions, [key]: { ...x, disabled: null } } } : e;
    });
    const id = this.id(key);
    if (r.ok && id) this.consoles.forget(addonIdOf(id));
    return r;
  }

  /** « Revoir l'accord » (disabled for a broadened scope): the card, in `fenetre`'s active space if the extension is active there. */
  async review(key: string, win: string | null): Promise<ExtensionResult> {
    const id = this.id(key);
    const state = await readExtensionsState(this.o.folder);
    const x = state.extensions[key];
    if (!id || !x) return { ok: false, error: `Extension inconnue : ${key}` };
    if (state.allCut) return { ok: false, error: REVIEW_DURING_OUTAGE };
    if (x.disabled?.reason !== "scope-widened") return { ok: false, error: NOTHING_TO_REVIEW };
    const nav = await this.browser();
    const privates = privateProfilesOf(nav);
    const active = nav.windows.find((f) => f.id === win)?.activeSpace;
    const space =
      nav.spaces.find((e) => e.id === active && x.profiles.includes(e.profile)) ??
      nav.spaces.find((e) => x.profiles.includes(e.profile) && !privates.has(e.profile)) ??
      nav.spaces.find((e) => e.id === active);
    if (!space) return { ok: false, error: "Aucun espace où la revoir" };
    const r = await this.ask(id, { space: space.id, window: win });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** A registry write for a known agent key, in its queue, then applied to its add-on; an error comes back as text. */
  private async writeKey(key: string, change: (e: ExtensionsState) => ExtensionsState): Promise<ExtensionResult> {
    const id = this.id(key);
    if (!id || !(key in (await readExtensionsState(this.o.folder)).extensions)) return { ok: false, error: `Extension inconnue : ${key}` };
    try {
      await this.queued(key, async () => {
        await this.edit((e) => (key in e.extensions ? change(e) : e));
        await this.apply(id, key);
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * `request_extension`: the space named (id or name, never a private one), else the
   * active space of the agent's window (or the foreground one); then the card, in that window.
   */
  private async ask(id: string, x: { space?: string; window: string | null; signal?: AbortSignal }): Promise<ExtensionRequestResult> {
    const key = this.key(id);
    if (!key) return { ok: false, error: `Identifiant d'extension invalide : ${id}` };
    const nav = await this.browser();
    const f = nav.windows.find((w) => w.id === x.window) ?? nav.windows.find((w) => w.id === nav.foreground) ?? nav.windows[0];
    let space: Space | undefined;
    if (x.space !== undefined) {
      const opened = nav.spaces.filter((e) => !e.private);
      space = opened.find((e) => e.id === x.space) ?? opened.find((e) => e.name.toLowerCase() === x.space!.toLowerCase());
      if (!space) return { ok: false, error: `Espace inconnu : ${x.space}` };
    } else space = nav.spaces.find((e) => e.id === f?.activeSpace);
    if (!space) return { ok: false, error: "Aucun espace actif" };
    const chosen = space;
    const r = await this.queued(key, () => this.activation(id, key, chosen, f?.id ?? null, x.signal));
    if (r.ok) return { ok: true, space: space.name };
    if (r.error === ACTIVATION_DENIED) return { ok: false, error: r.error, denied: true };
    if (r.error === ACTIVATION_REMOVED) return { ok: false, error: r.error, removed: true };
    return r;
  }

  /**
   * Activation: private profile → refused without a card; already granted and active there →
   * nothing asked. Else the copy is prepared and its card shown; accepted (the scope shown, the space still there and
   * not private), it is signed and installed on that scope, and only then granted and active in the space's profile.
   */
  private async activation(id: string, key: string, space: Space, win: string | null, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
    const profile = space.profile;
    const nav = await this.browser();
    if (privateProfilesOf(nav).has(profile)) return { ok: false, error: PRIVATE_PROFILE_ERROR };
    const state = await readExtensionsState(this.o.folder);
    if (state.allCut) return { ok: false, error: ALL_CUT_AGENT };
    const known = state.extensions[key];
    if (known?.disabled?.reason === "crashes") return { ok: false, error: DISABLED_CRASHES };
    if (known?.grant && !known.disabled && known.profiles.includes(profile)) {
      // Already granted and active: nothing asked again, but a folder gone is said.
      const path = await pathMarkers(this.o.agentFolder, id);
      if (typeof path === "string") return { ok: false, error: path === FOLDER_ABSENT ? folderAbsent(id) : path };
      return { ok: true };
    }

    const p = await this.prepare(id);
    if (!p.ok) return { ok: false, error: p.denial.map((r) => (r === FOLDER_ABSENT ? folderAbsent(id) : r)).join(" ; ") };
    const clear = () => rm(p.staging, { recursive: true, force: true });
    // A signing will be needed: without keys, nothing is shown and nothing leaves.
    if ((await this.guard(id))?.hash !== p.hash && !(await readAmoKey(this.env))) {
      await clear();
      return { ok: false, error: KEYS_ABSENT };
    }
    // Already active elsewhere with a narrower grant: the new copy replaces it there too, the card says so.
    const otherProfiles = known?.grant && widenedScope(known.grant, p.analysis.scope) ? known.profiles.filter((x) => x !== profile) : [];
    const alsoReplace = nav.spaces.filter((e) => !e.private && otherProfiles.includes(e.profile)).map((e) => e.name);
    const card = cardOf(p.analysis, { key: key, space: space, spaces: nav.spaces, alsoReplaces: alsoReplace });
    const r = await this.askGrant(key, card, win, signal);
    if (!(r.accepted && r.hash === card.hash)) {
      await clear();
      return { ok: false, error: r.removed ? ACTIVATION_REMOVED : ACTIVATION_DENIED };
    }
    // The state may have changed during the card: checked again on « yes ».
    const after = await this.browser();
    const here = after.spaces.find((e) => e.id === space.id);
    const stateAfter = await readExtensionsState(this.o.folder);
    const denial = !here
      ? SPACE_GONE
      : here.profile !== profile || privateProfilesOf(after).has(profile)
        ? PRIVATE_PROFILE_ERROR
        : stateAfter.allCut
          ? ALL_CUT_AGENT
          : known && !(key in stateAfter.extensions)
            ? REMOVED_DURING_CARD
            : null;
    if (denial) {
      await clear();
      return { ok: false, error: denial };
    }
    const e = await this.send(id, key, { grant: p.analysis.scope, activate: { spaceId: space.id, profile: profile, known: !!known } }, p);
    if (e.ok) this.noteSend(key, e);
    return e.ok ? { ok: true } : { ok: false, error: e.error };
  }

  /** The card in the chrome (`extensions.grant`); fallen, aborted or unanswerable: « retirée », never a refusal. */
  private async askGrant(key: string, card: ExtensionCard, win: string | null, signal?: AbortSignal): Promise<GrantResponse> {
    const removal = new AbortController();
    this.cards.set(key, removal);
    try {
      const signals = [removal.signal, this.stopSignal.signal, ...(signal ? [signal] : [])];
      return await this.o.rpc.request<GrantResponse>("extensions.grant", { card: card, window: win }, AbortSignal.any(signals));
    } catch {
      return { accepted: false, hash: card.hash, removed: true };
    } finally {
      if (this.cards.get(key) === removal) this.cards.delete(key);
    }
  }

  /** `reload_extension`: within its grant, signed and installed without a card; broadened, disabled (grant kept). */
  private reload(id: string): Promise<{ state: "reloaded" | "disabled" | "refused"; detail: string[] }> {
    const key = this.key(id);
    if (!key) return Promise.resolve({ state: "refused", detail: [`Identifiant d'extension invalide : ${id}`] });
    // A card left open for it holds its queue: it falls first.
    this.cards.get(key)?.abort();
    return this.queued(key, async () => {
      const grant = (await readExtensionsState(this.o.folder)).extensions[key]?.grant;
      if (!grant) return { state: "refused" as const, detail: [NO_GRANT] };
      const r = this.noteSend(key, await this.send(id, key, { grant: grant }));
      if (r.ok) return { state: "reloaded" as const, detail: [] };
      if (r.error === DISABLED_SCOPE) return { state: "disabled" as const, detail: [DISABLED_SCOPE] };
      return { state: "refused" as const, detail: r.denial ?? [r.error] };
    });
  }

  /** The Extensions page's « Supprimer »: its storage goes with the add-on, the agent's folder stays. */
  async deletePage(key: string): Promise<ExtensionResult> {
    if (!(key in (await readExtensionsState(this.o.folder)).extensions)) return { ok: false, error: `Extension inconnue : ${key}` };
    return this.remove(key).then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, error: (e as Error).message }),
    );
  }

  /**
   * « Supprimer »: uninstalled, copy and signed .xpi deleted, registry entry removed; amo-versions.json kept (AMO never reuses a number).
   * `outsideRessac`: about:addons' pending removal, which its Undo may have cancelled since: then nothing changes.
   */
  remove(key: string, outsideRessac = false): Promise<void> {
    const id = this.id(key);
    if (!id) return Promise.reject(new Error(`Identifiant d'extension invalide : ${key}`));
    this.cards.get(key)?.abort();
    return this.queued(key, async () => {
      // Uninstalled first: an entry gone while the add-on stays installed would run without a grant.
      const done = await this.o.rpc.request("extensions.uninstall", outsideRessac ? { addonId: addonIdOf(id), unlessUndone: true } : { addonId: addonIdOf(id) });
      if (done === false) return;
      await this.edit((e) => (key in e.extensions ? remove(e, key) : e));
      this.consoles.forget(addonIdOf(id));
      this.sendErrors.delete(key);
      for (const f of [join("copies", id), join("copies", `${id}.pending`), join("signed", `${id}.xpi`), join("signed", `${id}.json`)])
        await rm(join(this.o.folder, f), { recursive: true, force: true });
    });
  }

  /** about:addons removed it (« Supprimer », grant deleted) or disabled it (« Désactiver partout ») (decision 6). */
  async outsideRessac(addonId: string, what: "uninstalled" | "disabled"): Promise<void> {
    if (!addonId.endsWith(ID_SUFFIX)) return;
    const key = this.key(addonId.slice(0, -ID_SUFFIX.length));
    if (!key || !(key in (await readExtensionsState(this.o.folder)).extensions)) return;
    if (what === "uninstalled") return this.remove(key, true);
    await this.queued(key, () => this.edit((e) => (key in e.extensions ? disableEverywhere(e, key) : e)));
  }

  /**
   * The chrome saw it about to run in a tab of `profil` the agent cannot read: its
   * console stays masked to the agent there (`consoleMasquee`), and by add-on id (`consolesMasquees`, never emptied).
   */
  async ran(addonId: string, profile: string, readable: boolean): Promise<void> {
    if (readable || typeof addonId !== "string" || typeof profile !== "string" || !addonId.endsWith(ID_SUFFIX)) return;
    const key = this.key(addonId.slice(0, -ID_SUFFIX.length));
    if (!key) return;
    await this.queued(key, () =>
      this.edit((e) => {
        const x = e.extensions[key];
        if (x?.source !== "agent") return e;
        const hidden = e.hiddenConsoles?.includes(addonId) ? e.hiddenConsoles : [...(e.hiddenConsoles ?? []), addonId];
        const profiles = x.hiddenConsole?.includes(profile) ? x.hiddenConsole : [...(x.hiddenConsole ?? []), profile];
        return { ...e, hiddenConsoles: hidden, extensions: { ...e.extensions, [key]: { ...x, hiddenConsole: profiles } } };
      }),
    );
  }

  /**
   * The chrome's private profiles (`extensions.privateProfiles`): each agent extension
   * active in one is taken out of it, the tabs of those profiles where it ran are reloaded (A7: its scripts stop), and
   * it is disabled where it is active nowhere else.
   */
  async privateProfiles(privates: string[]): Promise<void> {
    const { removed: removed } = applyPrivateProfiles(await readExtensionsState(this.o.folder), new Set(privates));
    if (removed.length === 0) return;
    await this.edit((e) => e);
    const byKey = new Map<string, string[]>();
    for (const r of removed) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r.profile]);
    for (const [key, profiles] of byKey) {
      const id = this.id(key);
      if (!id) continue;
      this.o.rpc.notify("extensions.reloadTabs", { addonId: addonIdOf(id), profiles: profiles });
      await this.queued(key, () => this.apply(id, key));
    }
  }

  /**
   * The « Extensions » section of a space's settings (the agent's only): registry entries and the
   * agent's folders never granted (their names only), seen from that space's profile.
   */
  async forSpace(spaceId: string): Promise<SpaceExtensionLine[]> {
    const nav = await this.browser();
    const space = nav.spaces.find((e) => e.id === spaceId);
    if (!space) return [];
    const state = await readExtensionsState(this.o.folder);
    const others = nav.spaces.filter((e) => e.id !== space.id && e.profile === space.profile).map((e) => e.name);
    const grayed = privateProfilesOf(nav).has(space.profile) ? PRIVATE_PROFILE_ERROR : null;
    const lines: SpaceExtensionLine[] = Object.entries(state.extensions)
      .filter(([, x]) => x.source === "agent")
      .map(([key, x]) => {
        const active = x.profiles.includes(space.profile);
        return { key: key, name: x.name, source: "agent", active, alsoIn: active ? others : [], greyedOut: grayed, profiles: [...x.profiles] };
      });
    for (const d of await readdir(this.o.agentFolder, { withFileTypes: true }).catch(() => [])) {
      const key = this.key(d.name);
      if (!d.isDirectory() || !key || key in state.extensions) continue;
      lines.push({ key: key, name: d.name, source: "agent", active: false, alsoIn: [], greyedOut: grayed, profiles: [] });
    }
    return lines.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  }

  /**
   * A space settings' switch: off → taken out of the space's profile; on → refused in a private
   * profile, through the card without a grant (or disabled for a broadened scope), else active there at once.
   */
  async toggle(key: string, spaceId: string, active: boolean, win: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
    const id = this.id(key);
    if (!id) return { ok: false, error: `Extension inconnue : ${key}` };
    const nav = await this.browser();
    const space = nav.spaces.find((e) => e.id === spaceId);
    if (!space) return { ok: false, error: "Espace inconnu" };
    const profile = space.profile;
    const write = (change: (e: ExtensionsState, privates: ReadonlySet<string>) => ExtensionsState) =>
      this.queued(key, async () => {
        await this.edit(change);
        await this.apply(id, key);
      }).then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, error: (e as Error).message }),
      );
    if (!active) return write((e) => (key in e.extensions ? disable(e, key, profile) : e));
    if (privateProfilesOf(nav).has(profile)) return { ok: false, error: PRIVATE_PROFILE_ERROR };
    const state = await readExtensionsState(this.o.folder);
    if (state.allCut) return { ok: false, error: ALL_CUT_AGENT };
    const x = state.extensions[key];
    if (!(x?.grant && x.disabled === null)) {
      const r = await this.ask(id, { space: space.id, window: win });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    // Checked again in the serialized write: everything cut, or a disabling, may have come in between.
    return write((e, privates) => {
      if (e.allCut) throw new Error(ALL_CUT_AGENT);
      const d = e.extensions[key]?.disabled;
      if (d) throw new Error(d.reason === "crashes" ? DISABLED_CRASHES : DISABLED_SCOPE);
      return enable(e, key, profile, privates);
    });
  }

  /** Quitting: a signing in progress is dropped (its version number stays taken; the change is signed again at the next startup). */
  stop(): void {
    this.stopSignal.abort();
  }

  private key(id: string): string | null {
    try {
      return extensionKey("agent", id);
    } catch {
      return null;
    }
  }

  private id(key: string): string | null {
    return key.startsWith("agent:") && this.key(key.slice("agent:".length)) === key ? key.slice("agent:".length) : null;
  }

  private queued<T>(key: string, f: () => Promise<T>): Promise<T> {
    const next = (this.files.get(key) ?? Promise.resolve()).catch(() => {}).then(f);
    this.files.set(key, next);
    void next
      .finally(() => {
        if (this.files.get(key) === next) this.files.delete(key);
      })
      .catch(() => {});
    return next;
  }

  /** Registry change; the profiles of private spaces (asked from Firefox) are taken out of every agent extension. */
  private async edit(change: (e: ExtensionsState, privates: ReadonlySet<string>) => ExtensionsState): Promise<ExtensionsState> {
    const privates = privateProfilesOf(await this.browser());
    const e = await changeExtensionsState(this.o.folder, change, () => privates);
    this.checkUnlocks(e, privates);
    this.o.rpc.notify("extensions.scopes", scopesOf(e));
    this.o.rpc.notify("extensions.change");
    return e;
  }

  private browser(): Promise<Browser> {
    return this.o.rpc.request<Browser>("browser.spaces", {});
  }

  private async active(key: string): Promise<boolean> {
    const e = await readExtensionsState(this.o.folder);
    return activeIn(e, e.extensions[key]);
  }

  /** As the registry says (decision 4): active → the kept signed .xpi installed if missing, then enabled; inactive → disabled, never installed fresh. */
  private async apply(id: string, key: string): Promise<void> {
    const active = await this.active(key);
    if (active && this.toSign.delete(key)) return this.signEnabled(id, key);
    const kept = await this.guard(id);
    if (kept) await this.install(id, join(this.o.folder, "signed", `${id}.xpi`), kept.version, active);
    await this.o.rpc.request("extensions.enable", { addonId: addonIdOf(id), active: active });
  }

  /** Active again after a startup that did not sign its changed source: signed now, else the kept version runs. */
  private async signEnabled(id: string, key: string): Promise<void> {
    const x = (await readExtensionsState(this.o.folder)).extensions[key];
    const r = x?.grant ? this.noteSend(key, await this.send(id, key, { grant: x.grant, startup: true })) : null;
    // envoi applied it, or disabled it (broadened scope, folder gone); otherwise the kept version runs.
    if (!r?.ok && r?.error !== DISABLED_SCOPE && !r?.denial?.includes(FOLDER_ABSENT)) await this.apply(id, key);
  }

  /** Active once envoi is done: a scope-disabled one back within its grant runs again. */
  private async activeAfterSend(key: string): Promise<boolean> {
    const e = await readExtensionsState(this.o.folder);
    const x = e.extensions[key];
    return activeIn(e, x?.disabled?.reason === "scope-widened" ? { ...x, disabled: null } : x);
  }

  /** The last signed and installed version (`signed/<id>.json`), if its .xpi is there. */
  private async guard(id: string): Promise<{ version: string; hash: string } | null> {
    const signs = join(this.o.folder, "signed");
    if (!(await lstat(join(signs, `${id}.xpi`)).then(() => true, () => false))) return null;
    return readFile(join(signs, `${id}.json`), "utf8").then((t) => JSON.parse(t) as { version: string; hash: string }, () => null);
  }

  /** `active` false: Firefox installs it only over a present add-on (disabled first), never fresh. */
  private install(id: string, xpi: string, version: string, active: boolean): Promise<{ version: string } | null> {
    return this.o.rpc.request("extensions.install", { addonId: addonIdOf(id), xpi, temporary: !!this.env.RESSAC_TEST_AMO_URL, version, active: active });
  }

  /**
   * `activer`: a grant card was accepted for `grant` (the scope shown) in `profil`: installed active, and only once
   * installed is the grant written (`connue`: an entry existed when the card was shown). A failure leaves no grant.
   */
  private async send(
    id: string,
    key: string,
    o: { grant: Scope; startup?: boolean; activate?: { spaceId: string; profile: string; known: boolean } },
    prepare?: Preparation,
  ): Promise<SendResult> {
    const p = prepare ?? (await this.prepare(id));
    if (!p.ok) {
      // Only a missing folder stops the running version.
      if (p.denial.includes(FOLDER_ABSENT)) await this.o.rpc.request("extensions.enable", { addonId: addonIdOf(id), active: false });
      return { ok: false, error: p.denial.map((r) => (r === FOLDER_ABSENT ? folderAbsent(id) : r)).join(" ; "), denial: p.denial };
    }
    const { analysis: analysis, hash: hash, staging } = p;
    const clear = () => rm(staging, { recursive: true, force: true });
    if (widenedScope(o.grant, analysis.scope)) {
      await clear();
      await this.edit((e) => {
        const x = e.extensions[key];
        if (!x || x.disabled?.reason === "scope-widened") return e;
        return { ...e, extensions: { ...e.extensions, [key]: { ...x, disabled: { reason: "scope-widened", at: new Date().toISOString() } } } };
      });
      await this.apply(id, key);
      return { ok: false, error: DISABLED_SCOPE };
    }

    const signs = join(this.o.folder, "signed");
    let change = true;
    // Unchanged since the last signing (startup, a grant in another profile, or a reload): appliquer below reinstalls
    // the kept .xpi if it is missing, nothing is sent; a reload restarts the running one.
    const kept = await this.guard(id);
    if (kept?.hash === hash) {
      await clear();
      // A reload still counts as a new start (modifieeLe: its console unlock ends).
      if (!o.startup && !o.activate) await this.o.rpc.request("extensions.restart", { addonId: addonIdOf(id) });
      else change = false;
    } else if (o.startup && kept && !(await this.activeAfterSend(key))) {
      // Active nowhere: nothing leaves for AMO; the kept version stays until it is activated again.
      await clear();
      this.toSign.add(key);
      await this.apply(id, key);
      return { ok: true, analysis: analysis };
    } else {
      const r = await this.signAndInstall(id, p, o.activate ? true : await this.active(key));
      if (!r.ok) {
        await clear();
        return r;
      }
      this.toSign.delete(key);
      await writeFile(join(signs, `${id}.json`), JSON.stringify({ version: r.version, hash: hash }));
      const copy = join(this.o.folder, "copies", id);
      await rm(copy, { recursive: true, force: true });
      await rename(staging, copy);
    }
    const now = new Date().toISOString();
    const a = o.activate;
    if (a) {
      try {
        // The signing takes minutes: the space is checked again before anything is granted for it.
        const nav = await this.browser();
        const here = nav.spaces.find((e) => e.id === a.spaceId);
        if (!here) throw new Error(SPACE_GONE);
        if (here.profile !== a.profile || privateProfilesOf(nav).has(a.profile)) throw new Error(PRIVATE_PROFILE_ERROR);
        await this.edit((e, privates) => {
          if (e.allCut) throw new Error(ALL_CUT_AGENT);
          const x = e.extensions[key];
          if (a.known && !x) throw new Error(REMOVED_DURING_CARD);
          const base: ExtensionEntry = x ?? {
            source: "agent",
            addonId: null,
            name: analysis.name,
            version: analysis.version,
            grant: null,
            profiles: [],
            pinned: false,
            modifiedAt: null,
            disabled: null,
            pendingUpdate: null,
            seenVersions: {},
          };
          const entry: ExtensionEntry = {
            ...base,
            addonId: addonIdOf(id),
            name: analysis.name,
            version: analysis.version,
            grant: o.grant,
            modifiedAt: now,
            disabled: base.disabled?.reason === "crashes" ? base.disabled : null,
          };
          return enable({ ...e, extensions: { ...e.extensions, [key]: entry } }, key, a.profile, privates);
        });
      } catch (err) {
        await this.notGranted(id, key, analysis.scope);
        return { ok: false, error: (err as Error).message };
      }
      await this.apply(id, key);
      return { ok: true, analysis: analysis };
    }
    await this.edit((e) => {
      const x = e.extensions[key];
      if (!x?.grant) return e;
      const entry: ExtensionEntry = {
        ...x,
        addonId: addonIdOf(id),
        name: analysis.name,
        version: analysis.version,
        modifiedAt: change || !x.modifiedAt ? now : x.modifiedAt,
        // Back within its grant: it runs again. Not after crashes (re-enabled by hand).
        disabled: x.disabled?.reason === "scope-widened" && !widenedScope(x.grant, analysis.scope) ? null : x.disabled,
      };
      return { ...e, extensions: { ...e.extensions, [key]: entry } };
    });
    await this.apply(id, key);
    return { ok: true, analysis: analysis };
  }

  /**
   * A card's grant could not be written after its install: that add-on never runs beyond a grant. No entry →
   * uninstalled; an older, narrower grant → disabled for a broadened scope (grant kept); anything failing → disabled.
   */
  private async notGranted(id: string, key: string, scope: Scope): Promise<void> {
    try {
      const x = (await readExtensionsState(this.o.folder)).extensions[key];
      if (!x) return void (await this.o.rpc.request("extensions.uninstall", { addonId: addonIdOf(id) }));
      if (!x.grant || widenedScope(x.grant, scope))
        await this.edit((e) => {
          const y = e.extensions[key];
          if (!y || y.disabled) return e;
          return { ...e, extensions: { ...e.extensions, [key]: { ...y, disabled: { reason: "scope-widened", at: new Date().toISOString() } } } };
        });
      await this.apply(id, key);
    } catch (e) {
      console.error(`[extensions] ${key}: grant not written, disabled:`, e);
      await this.o.rpc.request("extensions.enable", { addonId: addonIdOf(id), active: false }).catch(() => {});
    }
  }

  /** nextVersion → firefoxManifest → zipper → signer (signed/<id>.pending.xpi) → extensions.installer → signed/<id>.xpi. */
  private async signAndInstall(id: string, p: { staging: string; originalBackground: string | undefined }, active: boolean): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
    const amoKey = await readAmoKey(this.env);
    if (!amoKey) return { ok: false, error: KEYS_ABSENT };
    const n = await nextVersion(this.o.folder, id);
    const path = join(p.staging, "manifest.json");
    const manifest = firefoxManifest(JSON.parse(await readFile(path, "utf8")), id, n, p.originalBackground);
    await writeFile(path, JSON.stringify(manifest, null, 2));
    const version = String(manifest.version);
    const signs = join(this.o.folder, "signed");
    const sending = join(signs, `${id}.upload.xpi`);
    const waiting = join(signs, `${id}.pending.xpi`);
    await mkdir(signs, { recursive: true });
    try {
      await zipper(p.staging, sending);
      await sign({ xpi: sending, guid: addonIdOf(id), version, key: amoKey, base: this.env.RESSAC_TEST_AMO_URL || AMO_URL, output: waiting, signal: this.stopSignal.signal });
    } catch (e) {
      await rm(waiting, { force: true });
      return { ok: false, error: e instanceof SignatureError ? e.message : signatureImpossible((e as Error).message) };
    } finally {
      await rm(sending, { force: true });
    }
    try {
      await this.install(id, waiting, version, active);
    } catch (e) {
      await rm(waiting, { force: true });
      return { ok: false, error: installationImpossible((e as Error).message) };
    }
    await rename(waiting, join(signs, `${id}.xpi`));
    return { ok: true, version };
  }

  /**
   * The controlled copy of `<dossierAgent>/<id>` in `copies/<id>.pending` (path without
   * links, checked before and after), plus the Firefox refusals. A refusal leaves no staging copy.
   */
  private async prepare(id: string): Promise<Preparation | { ok: false; denial: string[] }> {
    const staging = join(this.o.folder, "copies", `${id}.pending`);
    const deny = async (denial: string[]) => (await rm(staging, { recursive: true, force: true }), { ok: false as const, denial: denial });
    await rm(staging, { recursive: true, force: true });
    const before = await pathMarkers(this.o.agentFolder, id);
    if (typeof before === "string") return { ok: false, denial: [before] };
    let realBefore: string;
    try {
      realBefore = await realpath(this.o.agentFolder);
    } catch (e) {
      return { ok: false, denial: [`Dossier illisible : ${(e as Error).message}`] };
    }
    let r: Awaited<ReturnType<typeof prepareCopy>>;
    try {
      await mkdir(join(this.o.folder, "copies"), { recursive: true });
      r = await prepareCopy({ source: join(this.o.agentFolder, id), target: staging, keptFolder: DEFAULT_GUARDS });
    } catch (e) {
      return deny([`Copie impossible : ${(e as Error).message}`]);
    }
    const after = await pathMarkers(this.o.agentFolder, id);
    const realAfter = await realpath(this.o.agentFolder).catch(() => "");
    if (typeof after === "string" || !sameMarkers(before, after) || realAfter !== realBefore)
      return deny([typeof after === "string" ? after : "Dossier remplacé pendant la copie"]);
    const parsed = before[1]!;
    if (r.root && (r.root.path !== join(realBefore, id) || r.root.dev !== parsed.dev || r.root.ino !== parsed.ino)) return deny(["Dossier remplacé pendant la copie"]);
    if (r.analysis.denial.length > 0) return deny(r.analysis.denial);
    try {
      const manifest = JSON.parse(await readFile(join(staging, "manifest.json"), "utf8"));
      const denial = firefoxDenial(manifest, await readdir(staging, { recursive: true }));
      if (denial.length > 0) return deny(denial);
      // The original classic background, read from the copy's own generated ressac-background.js (never the agent's folder again).
      const background = /^importScripts\("ressac-background-guard\.js", ("(?:[^"\\]|\\.)*")\);$/m.exec(await readFile(join(staging, "ressac-background.js"), "utf8"));
      return { ok: true, analysis: r.analysis, hash: r.hash, staging, originalBackground: background ? (JSON.parse(background[1]!) as string) : undefined };
    } catch (e) {
      return deny([`Copie impossible : ${(e as Error).message}`]);
    }
  }
}
