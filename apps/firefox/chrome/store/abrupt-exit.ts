import { abruptExitReport, jetsamEnding, reportEnding, type Ending, type RunMark } from "../../shared/abrupt-exit";
import type { ReportedError } from "../../shared/telemetry";
import { testEnv } from "../test-env";

// System modules have setTimeout but no setInterval.
const { setInterval } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const MARK_EVERY_MS = 5 * 60_000;

/**
 * macOS's reports: JetsamEvent (memory kills) system-wide, crashes and hangs in the user's folder. RESSAC_TEST_DIAGNOSTIC_DIR
 * (tests) stands for the system folder only: the user's is always built for real (a path bug there once hid every report).
 */
function reportDirs(): { system: string; user: string } {
  // PathUtils.join takes one name per segment: a « a/b » segment throws.
  const user = PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, "Library", "Logs", "DiagnosticReports");
  return { system: testEnv("RESSAC_TEST_DIAGNOSTIC_DIR") ?? "/Library/Logs/DiagnosticReports", user };
}

// A run of days writes many JetsamEvents (~0.5 MB each): the newest few are enough to find the end.
const MAX_REPORTS = 20;

/** The newest report since `since` that names our end: a jetsam kill first (the likeliest on a small Mac). */
async function findEnding(since: number, pid: number | undefined): Promise<Ending | null> {
  const { system, user } = reportDirs();
  const recent = async (dirs: string[], keep: (name: string) => boolean) => {
    const out: { path: string; name: string; at: number }[] = [];
    for (const dir of new Set(dirs))
      for (const path of await IOUtils.getChildren(dir).catch(() => [] as string[])) {
        const name = PathUtils.filename(path);
        if (!keep(name)) continue;
        const at = (await IOUtils.stat(path).catch(() => null))?.lastModified ?? 0;
        if (at >= since) out.push({ path, name, at });
      }
    // Newest first: the report nearest the end.
    return out.sort((a, b) => b.at - a.at).slice(0, MAX_REPORTS);
  };
  for (const f of await recent([system], (n) => n.startsWith("JetsamEvent-"))) {
    const ending = jetsamEnding(await IOUtils.readUTF8(f.path).catch(() => ""), pid, f.at);
    if (ending) return ending;
  }
  // macOS writes a crash in the user's folder, a hang's spindump often in the system one.
  for (const f of await recent([user, system], (n) => n.toLowerCase().startsWith("ressac"))) {
    const ending = reportEnding(f.name, await IOUtils.readUTF8(f.path).catch(() => ""), pid, f.at);
    if (ending) return ending;
  }
  return null;
}

/**
 * A run mark in the profile, removed on a clean quit: one left at launch means the last run ended abruptly, and it is
 * reported (`report` sends only with the user's consent). The mark keeps when the Mac slept and woke, the last memory
 * pressure and the tab counts, so a kill after waking shows as such.
 */
export function installAbruptExitWatch(o: { report(e: ReportedError): void; consented: () => boolean; smallMac: boolean; saveMemory: () => boolean }): void {
  const file = PathUtils.join(PathUtils.profileDir, "ressac-run.json");
  let quitting = false;
  const mark: RunMark = { started: Date.now(), pid: Services.appinfo.processID, version: __RESSAC_VERSION__, smallMac: o.smallMac, saveMemory: o.saveMemory(), at: Date.now() };
  const write = (change: Partial<RunMark> = {}) => {
    if (quitting) return;
    let tabs = 0;
    let loadedTabs = 0;
    for (const w of Services.wm.getEnumerator("navigator:browser") as Iterable<any>)
      for (const t of w.gBrowser?.tabs ?? []) {
        tabs++;
        if (t.linkedPanel) loadedTabs++;
      }
    Object.assign(mark, change, { at: Date.now(), saveMemory: o.saveMemory(), tabs, loadedTabs, processes: ChromeUtils.getAllDOMProcesses().length });
    IOUtils.writeUTF8(file, JSON.stringify(mark)).catch(() => {});
  };

  void (async () => {
    const previous = (await IOUtils.readJSON(file).catch(() => null)) as RunMark | null;
    write();
    // macOS's reports are only read when this one may be sent.
    if (previous?.started && o.consented()) o.report(abruptExitReport(previous, await findEnding(previous.started, previous.pid).catch((e) => (console.warn("[abrupt-exit] reports unread:", e), null))));
  })().catch((e) => console.warn("[abrupt-exit] check failed:", e));

  Services.obs.addObserver(() => write({ sleptAt: Date.now() }), "sleep_notification");
  Services.obs.addObserver(() => write({ wokeAt: Date.now() }), "wake_notification");
  // « low-memory-ongoing » repeats every 10 s while pressure lasts: the first one is enough.
  Services.obs.addObserver((_s: unknown, _t: string, data: string) => data !== "low-memory-ongoing" && write({ pressureAt: Date.now() }), "memory-pressure");
  setInterval(() => write(), MARK_EVERY_MS);
  Services.obs.addObserver(() => {
    quitting = true;
    // IOUtils finishes its pending work before shutdown ends.
    IOUtils.remove(file, { ignoreAbsent: true }).catch(() => {});
  }, "quit-application-granted");
}
