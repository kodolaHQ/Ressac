import { describe, expect, it } from "vitest";
import { abruptExitReport, jetsamEnding, reportEnding, type RunMark } from "../shared/abrupt-exit";
import { errorEnvelope } from "../shared/telemetry";

const jetsam = (processes: object[], largestProcess = "WindowServer") =>
  '{"bug_type":"298","timestamp":"2026-11-25 12:51:53.00 +0100"}\n' + JSON.stringify({ date: "2026-11-25 12:51:53.87 +0100", largestProcess, processes });

describe("jetsamEnding", () => {
  it("finds our main process among the killed, with its reason and time", () => {
    const e = jetsamEnding(jetsam([{ name: "plugin-container", reason: "vm-pageshortage" }, { name: "ressac", pid: 7, reason: "vm-pageshortage" }], "ressac"), 7, 0);
    expect(e).toEqual({ kind: "jetsam", reason: "vm-pageshortage", at: Date.parse("2026-11-25T12:51:53.87+01:00"), largestIsOurs: true });
  });
  it("ignores a report where we only ran, another Ressac's kill, or one that is not JSON", () => {
    expect(jetsamEnding(jetsam([{ name: "ressac", pid: 7 }, { name: "stickersd", reason: "per-process-limit" }]), 7, 0)).toBeNull();
    expect(jetsamEnding(jetsam([{ name: "ressac", pid: 8, reason: "vm-pageshortage" }]), 7, 0)).toBeNull();
    expect(jetsamEnding("garbage", 7, 0)).toBeNull();
  });
  it("an unreadable date falls back to the file's", () => {
    const text = '{"bug_type":"298"}\n' + JSON.stringify({ date: "?", processes: [{ name: "ressac", pid: 7, reason: "highwater" }] });
    expect(jetsamEnding(text, 7, 42)?.at).toBe(42);
  });
});

describe("reportEnding", () => {
  it("tells a crash from a hang, and ignores other apps and the daily .diag reports", () => {
    expect(reportEnding("ressac-2026-11-25-1.ips", '{"bug_type":"309"}\n{"pid":7}', 7, 5)).toEqual({ kind: "crash", at: 5 });
    expect(reportEnding("ressac-2026-11-25-1.ips", '{"bug_type":"288"}\n{}', 7, 5)).toEqual({ kind: "hang", at: 5 });
    expect(reportEnding("ressac_2026-11-25-1.hang", "", 7, 5)).toEqual({ kind: "hang", at: 5 });
    expect(reportEnding("ressac_2026-11-25-003511_Mac.diag", "Date/Time: …", 7, 5)).toBeNull();
    expect(reportEnding("ressac-2026-11-25-1.ips", '{"bug_type":"211"}\n{}', 7, 5)).toBeNull();
    expect(reportEnding("Safari-2026.ips", '{"bug_type":"309"}\n{}', 7, 5)).toBeNull();
  });
  it("another Ressac's crash is not this run's end", () => {
    expect(reportEnding("ressac-2026-11-25-1.ips", '{"bug_type":"309"}\n{"pid":8}', 7, 5)).toBeNull();
  });
});

describe("abruptExitReport", () => {
  const t0 = Date.parse("2026-11-25T08:00:00Z");
  const mark: RunMark = { started: t0, version: "0.1.26", smallMac: true, saveMemory: true, at: t0 + 3_600_000, sleptAt: t0 + 600_000, wokeAt: t0 + 3_500_000, pressureAt: t0 + 3_540_000, tabs: 20, loadedTabs: 9, processes: 31 };

  it("a jetsam kill 1 min 40 s after waking", () => {
    const r = abruptExitReport(mark, { kind: "jetsam", reason: "vm-pageshortage", at: t0 + 3_600_000, largestIsOurs: false });
    expect(r).toMatchObject({ type: "AbruptExit", message: "jetsam vm-pageshortage" });
    expect(r.tags).toMatchObject({ kind: "jetsam", phase: "≤2 min after wake", sinceWakeSeconds: "100", sincePressureSeconds: "60", upMinutes: "60", tabs: "20", loadedTabs: "9", processes: "31", endKnown: "true", largestIsOurs: "false" });
  });
  it("no report found: the end is the last mark; asleep if it slept after its last wake", () => {
    const r = abruptExitReport({ ...mark, sleptAt: t0 + 3_590_000 }, null);
    expect(r).toMatchObject({ message: "unknown", tags: { kind: "unknown", phase: "asleep", endKnown: "false" } });
  });
  it("its tags reach the envelope, source kept", () => {
    const body = errorEnvelope({ ...abruptExitReport(mark, null), source: "chrome" }, { release: "0.1.27", home: "/Users/m", eventId: "e", now: new Date(t0) });
    expect(JSON.parse(body.split("\n")[2]!).tags).toMatchObject({ source: "chrome", kind: "unknown", previousVersion: "0.1.26" });
  });
});
