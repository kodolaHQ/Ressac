/**
 * A launch that never quit cleanly (macOS killed it for memory, a crash, a force quit): the next launch reports it.
 * Pure: runs in vitest and in the Firefox chrome.
 */
import type { ReportedError } from "./telemetry";

/** What the run kept on disk while it lived, rewritten on sleep, wake, memory pressure and every few minutes. */
export type RunMark = {
  started: number;
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

/** A JetsamEvent .ips (a one-line header then JSON): our main process if it was among the killed. */
export function jetsamEnding(text: string): Ending | null {
  try {
    const body = JSON.parse(text.slice(text.indexOf("\n") + 1));
    const killed = (body.processes ?? []).find((p: any) => p.name === MAIN && p.reason);
    if (!killed) return null;
    return { kind: "jetsam", reason: String(killed.reason), at: Date.parse(String(body.date).replace(" ", "T").replace(/ ([+-]\d\d)(\d\d)$/, "$1:$2")), largestIsOurs: body.largestProcess === MAIN };
  } catch {
    return null;
  }
}

/** A report of ours in ~/Library/Logs/DiagnosticReports: a crash (.ips bug type 309) or a hang (.hang, .spin, other .ips). */
export function reportEnding(name: string, text: string, at: number): Ending | null {
  if (!name.toLowerCase().startsWith(MAIN)) return null;
  if (!name.endsWith(".ips")) return { kind: "hang", at };
  try {
    return { kind: JSON.parse(text.slice(0, text.indexOf("\n"))).bug_type === "309" ? "crash" : "hang", at };
  } catch {
    return { kind: "hang", at };
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
