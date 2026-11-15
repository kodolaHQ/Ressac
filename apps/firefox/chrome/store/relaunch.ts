/** Waits for the app (pid $1) to be gone, 60 s at most, then opens the bundle again with the remaining arguments. */
export const RELAUNCH_SCRIPT = 'i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 300 ] && exit 1; sleep 0.2; done; shift; exec /usr/bin/open -n "$@"';

/** Arguments of `/bin/sh` for a relaunch of `app` once `pid` is gone, `env` given to the new process. */
export function relaunchArgs(pid: number, app: string, env: Record<string, string> = {}): string[] {
  return ["-c", RELAUNCH_SCRIPT, "sh", String(pid), ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), app];
}

/** The variables a relaunched process must keep (its profile): `open` passes none of ours otherwise. */
export const RELAUNCH_ENV = ["XRE_PROFILE_PATH", "XRE_PROFILE_LOCAL_PATH"];

/** RELAUNCH_ENV's values in this process, unset ones left out. */
export const relaunchEnv = (): Record<string, string> => Object.fromEntries(RELAUNCH_ENV.map((k) => [k, Services.env.get(k)]).filter(([, v]) => v));

/**
 * Reopens the app once this process has quit; the caller quits. Kept over Firefox's own restart (eRestart, through
 * updater.app on macOS): `open -n` carries RELAUNCH_ENV and behaves the same whether the build ships the updater or not
 * (dev builds do not). A pending update is applied at that launch either way.
 */
export function relaunchAfterQuit(env: Record<string, string> = {}): void {
  // Ressac.app/Contents/MacOS/ressac → Ressac.app
  const app = Services.dirsvc.get("XREExeF", Ci.nsIFile).parent.parent.parent.path;
  const sh = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  sh.initWithPath("/bin/sh");
  const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
  process.init(sh);
  process.startHidden = true;
  const args = relaunchArgs(Services.appinfo.processID, app, env);
  process.runw(false, args, args.length);
}
