import type { Action } from "../../shared/api";
import type { UpdatePhase } from "../../shared/model";
import type { ReportedError } from "../../shared/telemetry";
import { isSignatureFailure, isStaleUpdate, plistVersion, updatePhase } from "../../core/update";
import { relaunchAfterQuit, relaunchEnv } from "./relaunch";

const PHASES: readonly UpdatePhase[] = ["idle", "checking", "downloading", "ready", "failed", "unreachable", "unwritable", "disabled"];

/**
 * Firefox's updater (AppUpdater) mirrored into the state's `update`. One check at start; Firefox's own timer keeps
 * checking (app.update.interval), and a download it starts is followed through a new check.
 */
export function installUpdates(dispatch: (a: Action) => void, report: (e: ReportedError) => void): { check(): void; restart(): void } {
  // Firefox's About window has its own update block (download, restart button): Ressac's card and À propos are the ones.
  Services.ww.registerNotification((subject: unknown, topic: string) => {
    if (topic !== "domwindowopened") return;
    const win = subject as unknown as Window;
    win.addEventListener(
      "DOMContentLoaded",
      () => {
        if (win.document.documentURI === "chrome://browser/content/aboutDialog.xhtml") win.document.getElementById("updateBox")?.setAttribute("hidden", "true");
      },
      { once: true },
    );
  });
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
  const aus = Cc["@mozilla.org/updates/update-service;1"].getService(Ci.nsIApplicationUpdateService);
  const um = Cc["@mozilla.org/updates/update-manager;1"].getService(Ci.nsIUpdateManager);
  // Drops a download in progress and a ready update: Firefox applies a ready one at the next launch.
  const discard = () =>
    void aus
      .stopDownload()
      .then(() => um.cleanupActiveUpdates())
      .catch((e: unknown) => console.error("[update] update not discarded:", e));
  // macOS reports a non-writable app as updatable "with elevation" (UpdateService getCanApplyUpdates), so MANUAL_UPDATE
  // never comes: the download would end in pending-elevate and Firefox's elevation window at the next launch.
  if (!aus.disabled && aus.elevationRequired) {
    dispatch({ type: "setUpdate", update: { phase: "unwritable", version: null, progress: null } });
    // Firefox's background check skips an update needing elevation for this Gecko version (UpdateService #selectUpdate).
    for (const pref of ["app.update.elevate.version", "app.update.elevate.never"]) Services.prefs.setCharPref(pref, Services.appinfo.version);
    discard();
    // shortcut: an update on a new Gecko version still downloads in the background and is only dropped once downloaded;
    // block the timer itself if engine updates ship to non-writable installs.
    Services.obs.addObserver(discard, "update-downloaded");
    return { check() {}, restart() {} };
  }
  const { AppUpdater } = ChromeUtils.importESModule("resource://gre/modules/AppUpdater.sys.mjs");
  const updater = new AppUpdater();
  const stale = (phase: UpdatePhase, version: string | null) => isStaleUpdate(phase, version, __RESSAC_VERSION__, (a, b) => Services.vc.compare(a, b));
  // update.xml's displayVersion is not signed: a ready update is judged by the staged app's own version too, so an old
  // signed MAR offered under a new number never rolls Ressac back.
  // shortcut: an update that could not be staged (applied at restart) has no Updated.app to read and is judged by update.xml only.
  const stagedVersion = async (): Promise<string | null> => {
    const f = Services.dirsvc.get("UpdRootD", Ci.nsIFile);
    for (const part of ["updates", "0", "Updated.app", "Contents", "Info.plist"]) f.append(part);
    return plistVersion(await IOUtils.readUTF8(f.path).catch(() => ""));
  };
  const show = (phase: UpdatePhase, version: string | null, progress: number | null): void => {
    if (phase === "ready")
      void stagedVersion().then(
        (staged) => decide(phase, version, progress, staged),
        (e: unknown) => (console.error("[update] staged version not read:", e), decide(phase, version, progress, null)),
      );
    else decide(phase, version, progress, null);
  };
  const decide = (phase: UpdatePhase, version: string | null, progress: number | null, staged: string | null): void => {
    if (stale(phase, version) || stale(phase, staged)) {
      // shortcut: Firefox's timer offers it again every app.update.interval and it is dropped again; fine for test builds.
      dispatch({ type: "setUpdate", update: { phase: "idle", version: null, progress: null } });
      updater.stop();
      discard();
    } else dispatch({ type: "setUpdate", update: { phase, version, progress } });
  };
  updater.addListener((status: number, progress?: number, progressMax?: number) => {
    const phase = updatePhase(AppUpdater.STATUS.debugStringFor(status) ?? "");
    const update = updater.update as { displayVersion?: string; errorCode?: number } | null;
    const version = update?.displayVersion ?? null;
    const percent = phase === "downloading" && progress != null && progressMax ? Math.min(100, Math.round((progress / progressMax) * 100)) : null;
    // A check that finds the update already pending reports READY with no update object: its version is the manager's.
    if (phase === "ready" && !version)
      void um.getReadyUpdate().then(
        (u: { displayVersion?: string } | null) => show(phase, u?.displayVersion ?? null, null),
        (e: unknown) => console.error("[update] ready update not read:", e),
      );
    else show(phase, version, percent);
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
