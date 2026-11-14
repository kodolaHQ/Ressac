import type { Action } from "../../shared/api";
import type { UpdatePhase } from "../../shared/model";
import type { ReportedError } from "../../shared/telemetry";
import { isSignatureFailure, updatePhase } from "../../core/update";
import { relaunchAfterQuit, relaunchEnv } from "./relaunch";

const PHASES: readonly UpdatePhase[] = ["idle", "checking", "downloading", "ready", "failed", "unwritable", "disabled"];

/**
 * Firefox's updater (AppUpdater) mirrored into the state's `update`. One check at start; Firefox's own timer keeps
 * checking (app.update.interval), and a download it starts is followed through a new check.
 */
export function installUpdates(dispatch: (a: Action) => void, report: (e: ReportedError) => void): { check(): void; restart(): void } {
  // RESSAC_TEST_UPDATE=<phase>:<version> (e.g. ready:0.1.5): the dev app's policy disables the updater, so tests set the state.
  const test = Services.env.get("RESSAC_TEST_UPDATE");
  if (test) {
    const [phase, version = null] = test.split(":");
    if (PHASES.includes(phase as UpdatePhase)) dispatch({ type: "setUpdate", update: { phase: phase as UpdatePhase, version, progress: null } });
    return {
      check() {},
      restart() {
        const file = Services.env.get("RESSAC_TEST_REVEAL");
        if (file) void IOUtils.writeUTF8(file, "restart\n", { mode: "appendOrCreate" }).catch((e: unknown) => console.warn("[update] restart not noted:", e));
      },
    };
  }
  const { AppUpdater } = ChromeUtils.importESModule("resource://gre/modules/AppUpdater.sys.mjs");
  const updater = new AppUpdater();
  const um = Cc["@mozilla.org/updates/update-manager;1"].getService(Ci.nsIUpdateManager);
  updater.addListener((status: number, progress?: number, progressMax?: number) => {
    const phase = updatePhase(AppUpdater.STATUS.debugStringFor(status) ?? "");
    const update = updater.update as { displayVersion?: string; errorCode?: number } | null;
    const version = update?.displayVersion ?? null;
    const percent = phase === "downloading" && progress != null && progressMax ? Math.min(100, Math.round((progress / progressMax) * 100)) : null;
    // A check that finds the update already pending reports READY with no update object: its version is the manager's.
    if (phase === "ready" && !version)
      void um.getReadyUpdate().then(
        (u: { displayVersion?: string } | null) => dispatch({ type: "setUpdate", update: { phase, version: u?.displayVersion ?? null, progress: null } }),
        (e: unknown) => console.error("[update] ready update not read:", e),
      );
    else dispatch({ type: "setUpdate", update: { phase, version, progress: percent } });
    // shortcut: reads the errorCode AppUpdater's own update object carries; a refusal only seen at apply time (after the
    // restart) is not reported here.
    if (phase === "failed" && isSignatureFailure(update?.errorCode ?? 0))
      report({ source: "chrome", type: "UpdateVerificationFailed", message: `update ${version ?? "?"} refused, error ${update?.errorCode}` });
  });
  const check = () => void updater.check().catch((e: unknown) => console.error("[update] check failed:", e));
  // A download Firefox's timer starts in the background: a new check follows it to READY_FOR_RESTART (ignored while busy).
  for (const topic of ["update-downloading", "update-downloaded"]) Services.obs.addObserver(check, topic);
  check();
  return {
    check,
    restart() {
      relaunchAfterQuit(relaunchEnv());
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
    },
  };
}
