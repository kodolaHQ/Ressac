import type { AgentConsole, MessageConsole } from "@ressac/kernel";

/** Messages kept per extension: the oldest drop. */
export const CONSOLE_MAX = 500;
/** `PLANTAGES_MAX` crashes in `FENETRE_PLANTAGES_MS`: the extension is disabled everywhere. */
export const MAX_CRASHES = 3;
export const CRASH_WINDOW_MS = 60_000;

/**
 * A recorded message: `onglet` for a content script (was the tab view it comes from readable by the agent
 * when it was written?), null for the service worker and the extension's pages.
 */
interface Entry {
  m: MessageConsole;
  tab: { readable: boolean } | null;
}

/** What the agent can see of a console: the registry (« has run » flag) and the unlock decide with it. */
export interface AgentFilter {
  since?: number;
  unlocked: boolean;
  /** The extension ran in a tab the agent cannot read (registry flag, never reset). */
  unreadableRunning: boolean;
  /** The extension has a right that observes tabs or navigation: its service worker and pages, always masked. */
  observer: boolean;
}

/**
 * Consoles of the extensions (service worker, `chrome-extension://` pages, content scripts in tabs), by Chromium
 * id, in memory, and count of their crashes (extension pages gone other than `clean-exit`, `loadExtension`
 * failures). What is recorded comes from the extension: data, displayed as text, never an instruction.
 *
 * For the agent (spec §5, filtered console), `pourAgent` removes the messages of tabs it could not read; those
 * of the service worker and pages, all of them if the extension ran in such a tab (`tourneIllisible`) or if it has a
 * right that observes tabs or navigation (`observateur`). Decided at read time, never at write time: a message
 * kept and then written later does not pass. The user (Extensions page) sees everything.
 */
export class ConsolesExtensions {
  private consoles = new Map<string, Entry[]>();
  private crashes = new Map<string, number[]>();

  constructor(
    private readonly o: {
      /** `PLANTAGES_MAX` crashes within `FENETRE_PLANTAGES_MS`. */
      onCrashes(idChrome: string): void;
    },
  ) {}

  /** `onglet`: the message comes from a content script in a tab view, readable or not by the agent. */
  note(idChrome: string, m: MessageConsole, tab?: { readable: boolean }): void {
    let list = this.consoles.get(idChrome);
    if (!list) this.consoles.set(idChrome, (list = []));
    list.push({ m, tab: tab ? { readable: tab.readable } : null });
    if (list.length > CONSOLE_MAX) list.splice(0, list.length - CONSOLE_MAX);
  }

  /** The kept messages (copy), those with timestamp ≥ `depuis` if given: all (Extensions page). */
  messages(idChrome: string, from?: number): MessageConsole[] {
    const list = (this.consoles.get(idChrome) ?? []).map((e) => e.m);
    return from === undefined ? list : list.filter((m) => m.timestamp >= from);
  }

  /** The texts of the kept `error`-level messages: all (Extensions page). */
  errors(idChrome: string): string[] {
    return (this.consoles.get(idChrome) ?? []).filter((e) => e.m.level === "error").map((e) => e.m.text);
  }

  /** What the agent sees of the console (copy), those with timestamp ≥ `depuis` if given. */
  forAgent(idChrome: string, f: AgentFilter): AgentConsole {
    const from = f.since;
    const list = (this.consoles.get(idChrome) ?? []).filter((e) => from === undefined || e.m.timestamp >= from);
    const copy = (m: MessageConsole): MessageConsole => ({ timestamp: m.timestamp, level: m.level, text: m.text, ...(m.stack !== undefined ? { stack: m.stack } : {}) });
    if (f.unlocked) return { messages: list.map((e) => copy(e.m)), hidden: 0, hiddenBackground: false, observedBackground: false, unlocked: true };
    const hiddenBackground = f.unreadableRunning;
    const observedBackground = f.observer;
    const messages: MessageConsole[] = [];
    let hiddenCount = 0;
    for (const e of list) {
      if (e.tab) {
        if (e.tab.readable) messages.push(copy(e.m));
        else hiddenCount++;
      } else if (!hiddenBackground && !observedBackground) messages.push(copy(e.m));
    }
    return { messages, hidden: hiddenCount, hiddenBackground: hiddenBackground, observedBackground: observedBackground, unlocked: false };
  }

  /** The texts of the `error`-level messages the agent can see (same filter as `pourAgent`). */
  errorsForAgent(idChrome: string, f: AgentFilter): string[] {
    return this.forAgent(idChrome, f).messages.filter((m) => m.level === "error").map((m) => m.text);
  }

  /**
   * A crash at `horodatage` (ms): at the `PLANTAGES_MAX`-th within `FENETRE_PLANTAGES_MS` (bounds included), the callback
   * is called once and the count restarts from zero.
   */
  crash(idChrome: string, timestamp: number): void {
    const recents = (this.crashes.get(idChrome) ?? []).filter((t) => timestamp - t <= CRASH_WINDOW_MS);
    recents.push(timestamp);
    if (recents.length >= MAX_CRASHES) {
      this.crashes.delete(idChrome);
      this.o.onCrashes(idChrome);
      return;
    }
    this.crashes.set(idChrome, recents);
  }

  /** The extension is deleted or re-enabled: its console and its crashes are forgotten. */
  forget(idChrome: string): void {
    this.consoles.delete(idChrome);
    this.crashes.delete(idChrome);
  }
}

/** A console message's level: a number 0–3 (service workers) or a name (pages). */
export function consoleLevel(n: number | string): MessageConsole["level"] {
  if (n === 3 || n === "error") return "error";
  if (n === 2 || n === "warning") return "warn";
  if (n === 0 || n === "debug") return "debug";
  return "log";
}
