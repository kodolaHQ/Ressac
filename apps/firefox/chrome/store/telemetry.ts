import { createReporter, parseDsn, type ReportedError } from "../../shared/telemetry";

const ENABLED = "webaios.telemetry.enabled";
// Our own chrome only: a web page's errors are its own (and would carry its addresses).
const OURS = "chrome://browser/content/webaios/";

/**
 * Error reports to Sentry: our chrome's console errors and what the store passes in (the host's).
 * Inactive without a DSN (the build's, or WEBAIOS_SENTRY_DSN); off while the pref is false.
 */
export function installTelemetry(): { report(e: ReportedError): void; active: boolean } {
  const dsn = Services.env.get("WEBAIOS_SENTRY_DSN") || __WEBAIOS_SENTRY_DSN__;
  const active = parseDsn(dsn) !== null;
  const enabled = () => Services.prefs.getBoolPref(ENABLED, false);
  const reporter = createReporter({
    dsn,
    release: Services.appinfo.version,
    home: Services.dirsvc.get("Home", Ci.nsIFile).path,
    enabled,
    post: (url, body) => fetch(url, { method: "POST", body }),
  });
  // Firefox's own crash reports follow the same choice. A build without a crash reporter has no such interface.
  const syncCrashReports = () => {
    try {
      const crashReporter = Services.appinfo.QueryInterface(Ci.nsICrashReporter);
      const on = active && enabled();
      if (crashReporter.submitReports !== on) crashReporter.submitReports = on;
    } catch {}
  };
  syncCrashReports();
  Services.prefs.addObserver(ENABLED, syncCrashReports);
  if (active)
    Services.console.registerListener({
      observe(m: any) {
        if (!(m instanceof Ci.nsIScriptError) || m.flags & (Ci.nsIScriptError.warningFlag | Ci.nsIScriptError.infoFlag)) return;
        if (!m.sourceName.startsWith(OURS)) return;
        const typed = /^(\w+): ([\s\S]*)$/.exec(m.errorMessage);
        const stack = m.stack ? String(m.stack) : `@${m.sourceName}:${m.lineNumber}:${m.columnNumber}`;
        reporter.report({ source: "chrome", type: typed?.[1] ?? "Error", message: typed?.[2] ?? m.errorMessage, stack });
      },
    });
  return { report: reporter.report, active };
}
