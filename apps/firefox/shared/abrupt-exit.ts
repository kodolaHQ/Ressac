/**
 * A launch that never quit cleanly (macOS killed it for memory, a crash, a force quit): the next launch reports it.
 * Pure: runs in vitest and in the Firefox chrome.
 */
import type { ReportedError } from "./telemetry";

/** What the run kept on disk while it lived, rewritten on sleep, wake, memory pressure and every few minutes. */
export type RunMark = {
  started: number;
  /** Ties macOS's reports to this run, not another Ressac's (an e2e run, a second profile). */
  pid?: number;
  version: string;
  smallMac: boolean;
  saveMemory: boolean;
  at: number;
  sleptAt?: number;
  wokeAt?: number;
  pressureAt?: number;
  tabs?: number;
  loadedTabs?: number;
  processes?: number;
};

export type Ending = { kind: "jetsam"; reason: string; at: number; largestIsOurs: boolean } | { kind: "crash" | "hang"; at: number };

/** The main process's executable name (Contents/MacOS/ressac), as macOS names it in its reports. */
const MAIN = "ressac";

/** A JetsamEvent .ips (a one-line header then JSON): our main process if it was among the killed. `fileAt` stands in for an unreadable date. */
export function jetsamEnding(text: string, pid: number | undefined, fileAt: number): Ending | null {
  try {
    const body = JSON.parse(text.slice(text.indexOf("\n") + 1));
    const killed = (body.processes ?? []).find((p: any) => p.name === MAIN && p.reason && (pid === undefined || p.pid === pid));
    if (!killed) return null;
    const at = Date.parse(String(body.date).replace(" ", "T").replace(/ ([+-]\d\d)(\d\d)$/, "$1:$2")) || fileAt;
    return { kind: "jetsam", reason: String(killed.reason), at, largestIsOurs: body.largestProcess === MAIN };
  } catch {
    return null;
  }
}

// shortcut: hang bug types 288 and 409 are from Apple's crash reporter usage, not a documented list; re-check on a real hang report
const HANG_TYPES = new Set(["288", "409"]);

/**
 * A report of ours in ~/Library/Logs/DiagnosticReports: a crash (.ips bug type 309) or a hang (.hang, .spin, a hang
 * .ips). Anything else (the daily .diag CPU reports) is not an end.
 */
export function reportEnding(name: string, text: string, pid: number | undefined, at: number): Ending | null {
  if (!name.toLowerCase().startsWith(MAIN)) return null;
  if (/\.(hang|spin)$/.test(name)) return { kind: "hang", at };
  if (!name.endsWith(".ips")) return null;
  try {
    const nl = text.indexOf("\n");
    const type = String(JSON.parse(text.slice(0, nl)).bug_type);
    const kind = type === "309" ? "crash" : HANG_TYPES.has(type) ? "hang" : null;
    if (!kind) return null;
    // Another Ressac's report (its pid is in the body) is not this run's end.
    const reportPid = (() => {
      try {
        return JSON.parse(text.slice(nl + 1)).pid;
      } catch {
        return undefined;
      }
    })();
    return pid !== undefined && typeof reportPid === "number" && reportPid !== pid ? null : { kind, at };
  } catch {
    return null;
  }
}

const secs = (ms: number) => String(Math.round(ms / 1000));

/** The error the reporter sends: grouped in Sentry by kind (and jetsam reason), the numbers as tags. */
export function abruptExitReport(mark: RunMark, ending: Ending | null): ReportedError {
  const end = ending?.at ?? mark.at;
  const asleep = mark.sleptAt !== undefined && (mark.wokeAt === undefined || mark.sleptAt > mark.wokeAt);
  const tags: Record<string, string> = {
    kind: ending?.kind ?? "unknown",
    previousVersion: mark.version,
    smallMac: String(mark.smallMac),
    saveMemory: String(mark.saveMemory),
    upMinutes: String(Math.round((end - mark.started) / 60_000)),
    // Without a report, the end is only known to fall after the last mark.
    endKnown: String(!!ending),
    phase: asleep ? "asleep" : mark.wokeAt === undefined ? "no wake" : end - mark.wokeAt <= 120_000 ? "≤2 min after wake" : end - mark.wokeAt <= 600_000 ? "≤10 min after wake" : "awake",
  };
  if (mark.wokeAt !== undefined) tags.sinceWakeSeconds = secs(end - mark.wokeAt);
  if (mark.pressureAt !== undefined) tags.sincePressureSeconds = secs(end - mark.pressureAt);
  for (const k of ["tabs", "loadedTabs", "processes"] as const) if (mark[k] !== undefined) tags[k] = String(mark[k]);
  if (ending?.kind === "jetsam") {
    tags.jetsamReason = ending.reason;
    tags.largestIsOurs = String(ending.largestIsOurs);
  }
  return { source: "chrome", type: "AbruptExit", message: ending?.kind === "jetsam" ? `jetsam ${ending.reason}` : (ending?.kind ?? "unknown"), tags };
}
