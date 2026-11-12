import { backupDate, RESET_FILE } from "../../core/state/format";

const ENABLED = "webaios.telemetry.enabled";
const EXPORT_NAME = /^WebAiOs-donnees-\d{4}-\d{2}-\d{2}( \(\d+\))?\.zip$/;

export interface SettingsChrome {
  telemetry(): { available: boolean; enabled: boolean };
  setTelemetry(enabled: boolean): void;
  version(): string;
  reveal(path: string): void;
  /** macOS's System Settings › Notifications: a site's or the watch's notification never shows while WebAiOs is off there. */
  openNotificationSettings(): void;
  /** System Settings › Privacy & Security › Full Disk Access: Safari's bookmarks and history are behind it. */
  openFullDiskAccessSettings(): void;
  exportFolder(): Promise<string>;
  /** false: the quit was cancelled (a window or an observer kept it), and the reset request is withdrawn. */
  reset(): Promise<boolean>;
}

/** What « Afficher dans le Finder » may show: the data folder, the agent's browsing notes, a backup, or an export file directly in the export folder. */
export function revealable(dataDir: string, exportFolder: string, path: string): boolean {
  if (typeof path !== "string" || path.includes("\0")) return false;
  if (path === dataDir || path === `${dataDir}/workspace/browsing-notes.md` || backupDate(dataDir, path) !== null) return true;
  if (!exportFolder || !path.startsWith(exportFolder + "/")) return false;
  return EXPORT_NAME.test(path.slice(exportFolder.length + 1));
}

function openSystemSettings(url: string): void {
  const test = Services.env.get("WEBAIOS_TEST_REVEAL");
  if (test) return void IOUtils.writeUTF8(test, url + "\n", { mode: "appendOrCreate" }).catch((e: unknown) => console.warn("[settings] open not noted:", e));
  try {
    const handler = Cc["@mozilla.org/uriloader/external-protocol-service;1"].getService(Ci.nsIExternalProtocolService).getProtocolHandlerInfo("x-apple.systempreferences");
    handler.preferredAction = Ci.nsIHandlerInfo.useSystemDefault;
    handler.launchWithURI(Services.io.newURI(url));
  } catch (e) {
    console.warn("[settings] system settings not opened:", e);
  }
}

export function createSettingsChrome(dataDir: string, telemetryActive: boolean): SettingsChrome {
  let lastExportFolder = "";
  return {
    telemetry: () => ({ available: telemetryActive, enabled: Services.prefs.getBoolPref(ENABLED, false) }),
    setTelemetry: (enabled) => Services.prefs.setBoolPref(ENABLED, enabled === true),
    version: () => __WEBAIOS_VERSION__,
    reveal(path) {
      if (!revealable(dataDir, lastExportFolder, path)) return;
      const test = Services.env.get("WEBAIOS_TEST_REVEAL");
      if (test) return void IOUtils.writeUTF8(test, path + "\n", { mode: "appendOrCreate" }).catch((e: unknown) => console.warn("[settings] reveal not noted:", e));
      try {
        const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        f.initWithPath(path);
        f.reveal();
      } catch (e) {
        console.warn("[settings] path not shown:", e);
      }
    },
    openNotificationSettings: () => openSystemSettings("x-apple.systempreferences:com.apple.Notifications-Settings.extension"),
    openFullDiskAccessSettings: () => openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"),
    async exportFolder() {
      const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
      return (lastExportFolder = await Downloads.getPreferredDownloadsDirectory());
    },
    async reset() {
      const marker = PathUtils.join(dataDir, RESET_FILE);
      await IOUtils.writeUTF8(marker, "");
      // Asked as every Firefox quit path does (downloads in progress…), and in the same task as quit(), so our windows
      // skip their pages' questions. A quit kept by an observer or a window must not reset at some later launch.
      const cancel = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
      Services.obs.notifyObservers(cancel, "quit-application-requested", "restart");
      if (!cancel.data) Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | (Services.env.get("WEBAIOS_TEST_NO_RESTART") === "1" ? 0 : Ci.nsIAppStartup.eRestart));
      // attemptingQuit: every window agreed to close (shuttingDown waits for them to be closed).
      if (!cancel.data && Services.startup.attemptingQuit) return true;
      await IOUtils.remove(marker, { ignoreAbsent: true });
      return false;
    },
  };
}
