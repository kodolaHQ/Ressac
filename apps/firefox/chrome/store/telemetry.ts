import { createReporter, launchSession, parseDsn, type ReportedError } from "../../shared/telemetry";

const ENABLED = "ressac.telemetry.enabled";
const INSTALL_ID = "ressac.telemetry.installId";
const NOTICE_SHOWN = "ressac.telemetry.noticeShown";
// Our own chrome only: a web page's errors are its own (and would carry its addresses).
const CRASH_TAB_SEND = "browser.tabs.crashReporting.sendReport";
const OURS = "chrome://browser/content/ressac/";

/**
 * Error reports to Sentry: our chrome's console errors and what the store passes in (the host's).
 * Inactive without a DSN (the build's, or RESSAC_SENTRY_DSN); off while the pref is false, and until the once-ever
 * notice (chrome/window) has shown: nothing leaves before the user could say no, even a first launch's early errors.
 */
export function installTelemetry(): { report(e: ReportedError): void; active: boolean } {
  const dsn = Services.env.get("RESSAC_SENTRY_DSN") || __RESSAC_SENTRY_DSN__;
  const active = parseDsn(dsn) !== null;
  const enabled = () => Services.prefs.getBoolPref(ENABLED, false);
  const consented = () => enabled() && Services.prefs.getBoolPref(NOTICE_SHOWN, false);
  const reporter = createReporter({
    dsn,
    release: __RESSAC_VERSION__,
    home: Services.dirsvc.get("Home", Ci.nsIFile).path,
    enabled: consented,
    post: (url, body) => fetch(url, { method: "POST", body }),
  });
  // Firefox's own crash reports follow the same choice. A build without a crash reporter has no such interface.
  const syncCrashReports = () => {
    try {
      const crashReporter = Services.appinfo.QueryInterface(Ci.nsICrashReporter);
      const on = active && consented();
      if (crashReporter.submitReports !== on) crashReporter.submitReports = on;
      // The crashed-tab page's "send report" box starts from this pref.
      Services.prefs.setBoolPref(CRASH_TAB_SEND, on);
    } catch {}
  };
  syncCrashReports();
  Services.prefs.addObserver(ENABLED, () => {
    syncCrashReports();
    // Off wipes the install id whatever turned it off (the setting, the first-run choice).
    if (!enabled()) Services.prefs.clearUserPref(INSTALL_ID);
  });
  Services.prefs.addObserver(NOTICE_SHOWN, syncCrashReports);
  launchSession({
    dsn,
    release: __RESSAC_VERSION__,
    // The notice shows on the first launch: count from the next one, after the user could say no.
    enabled: consented,
    post: (url, body) => fetch(url, { method: "POST", body }),
    ids: {
      get: () => Services.prefs.getStringPref(INSTALL_ID, "") || undefined,
      set: (id) => Services.prefs.setStringPref(INSTALL_ID, id),
      clear: () => Services.prefs.clearUserPref(INSTALL_ID),
    },
    newId: () => crypto.randomUUID(),
  });
  if (active)
    Services.console.registerListener({
      observe(m: any) {
        if (!(m instanceof Ci.nsIScriptError) || m.flags & (Ci.nsIScriptError.warningFlag | Ci.nsIScriptError.infoFlag)) return;
        // JSWindowActor modules run in content processes: their errors come from inside web pages.
        if (!m.sourceName.startsWith(OURS) || m.sourceName.endsWith("-actor.sys.mjs")) return;
        const typed = /^(\w+): ([\s\S]*)$/.exec(m.errorMessage);
        const stack = m.stack ? String(m.stack) : `@${m.sourceName}:${m.lineNumber}:${m.columnNumber}`;
        reporter.report({ source: "chrome", type: typed?.[1] ?? "Error", message: typed?.[2] ?? m.errorMessage, stack });
      },
    });
  return { report: reporter.report, active };
}
