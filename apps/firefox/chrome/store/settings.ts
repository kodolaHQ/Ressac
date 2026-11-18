import { backupDate, RESET_FILE } from "../../core/state/format";
import { updateDownloadUrl } from "../../core/update";
import { relaunchAfterQuit } from "./relaunch";

const ENABLED = "ressac.telemetry.enabled";
/** Firefox's own default browser service. */
export const SHELL_SERVICE = "moz-src:///browser/components/shell/ShellService.sys.mjs";
const EXPORT_NAME = /^Ressac-donnees-\d{4}-\d{2}-\d{2}( \(\d+\))?\.zip$/;

export interface SettingsChrome {
  telemetry(): { available: boolean; enabled: boolean };
  setTelemetry(enabled: boolean): void;
  version(): string;
  reveal(path: string): void;
  /** macOS's System Settings › Notifications: a site's or the watch's notification never shows while Ressac is off there. */
  openNotificationSettings(): void;
  /** System Settings › Privacy & Security › Full Disk Access: Safari's bookmarks and history are behind it. */
  openFullDiskAccessSettings(): void;
  /** System Settings › Privacy & Security › Files and Folders: macOS 26+ asks there before Ressac reads another app's data. */
  openFilesAndFoldersSettings(): void;
  /** Whether macOS opens web links with Ressac. */
  defaultBrowser(): boolean;
  /** Asks macOS, which shows its own confirmation: the answer comes later, in `defaultBrowser()`. */
  setDefaultBrowser(): void;
  /**
   * Forgets macOS's screen recording grant for Ressac, so macOS asks again at the next share (after a relaunch). A new
   * version signed ad hoc is another application for macOS: the old grant still shows as on but no longer counts.
   */
  repairScreenSharing(): Promise<boolean>;
  exportFolder(): Promise<string>;
  /** false: the quit was cancelled (a window or an observer kept it), and the reset request is withdrawn. */
  reset(): Promise<boolean>;
  checkForUpdate(): void;
  restartToUpdate(): void;
  /** The latest DMG, next to this build's update feed. */
  updateDownloadUrl(): string;
}

/** What « Afficher dans le Finder » may show: the data folder, the agent's browsing notes, a backup, or an export file directly in the export folder. */
export function revealable(dataDir: string, exportFolder: string, path: string): boolean {
  if (typeof path !== "string" || path.includes("\0")) return false;
  if (path === dataDir || path === `${dataDir}/workspace/.ressac/browsing-notes.md` || backupDate(dataDir, path) !== null) return true;
  if (!exportFolder || !path.startsWith(exportFolder + "/")) return false;
  return EXPORT_NAME.test(path.slice(exportFolder.length + 1));
}

/** The application's identifier for macOS, from its Info.plist. */
export function bundleId(plist: string): string | null {
  return /<key>CFBundleIdentifier<\/key>\s*<string>([\w.-]+)<\/string>/.exec(plist)?.[1] ?? null;
}

function openSystemSettings(url: string): void {
  const test = Services.env.get("RESSAC_TEST_REVEAL");
  if (test) return void IOUtils.writeUTF8(test, url + "\n", { mode: "appendOrCreate" }).catch((e: unknown) => console.warn("[settings] open not noted:", e));
  try {
    const handler = Cc["@mozilla.org/uriloader/external-protocol-service;1"].getService(Ci.nsIExternalProtocolService).getProtocolHandlerInfo("x-apple.systempreferences");
    handler.preferredAction = Ci.nsIHandlerInfo.useSystemDefault;
    handler.launchWithURI(Services.io.newURI(url));
  } catch (e) {
    console.warn("[settings] system settings not opened:", e);
  }
}

export function createSettingsChrome(dataDir: string, telemetryActive: boolean, updates: { check(): void; restart(): void }): SettingsChrome {
  let lastExportFolder = "";
  // A test never changes the owner's macOS (default browser, screen recording grant): the request is only remembered.
  const test = !!Services.env.get("RESSAC_TEST_NO_SYSTEM");
  let testDefault = false;
  const shell = () => ChromeUtils.importESModule(SHELL_SERVICE).ShellService;
  return {
    telemetry: () => ({ available: telemetryActive, enabled: Services.prefs.getBoolPref(ENABLED, false) }),
    setTelemetry: (enabled) => Services.prefs.setBoolPref(ENABLED, enabled === true),
    version: () => __RESSAC_VERSION__,
    checkForUpdate: () => updates.check(),
    restartToUpdate: () => updates.restart(),
    // The packaged app's feed is its AppUpdateURL policy (scripts/package.sh), as for Firefox's own check.
    updateDownloadUrl: () => updateDownloadUrl(String(Services.policies?.getActivePolicies()?.AppUpdateURL ?? Services.appinfo.updateURL)),
    reveal(path) {
      if (!revealable(dataDir, lastExportFolder, path)) return;
      const test = Services.env.get("RESSAC_TEST_REVEAL");
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
    openFilesAndFoldersSettings: () => openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"),
    defaultBrowser() {
      if (test) return testDefault;
      try {
        return shell().isDefaultBrowser(false) === true;
      } catch (e) {
        console.warn("[settings] default browser not read:", e);
        return false;
      }
    },
    setDefaultBrowser() {
      if (test) return void (testDefault = true);
      try {
        shell().setDefaultBrowser(false);
      } catch (e) {
        console.warn("[settings] default browser not set:", e);
      }
    },
    async repairScreenSharing() {
      if (test) return true;
      try {
        // Ressac.app/Contents/MacOS/ressac → Ressac.app/Contents/Info.plist
        const id = bundleId(await IOUtils.readUTF8(PathUtils.join(Services.dirsvc.get("XREExeF", Ci.nsIFile).parent.parent.path, "Info.plist")));
        if (!id) throw new Error("no CFBundleIdentifier in Info.plist");
        const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
        const proc = await Subprocess.call({ command: "/usr/bin/tccutil", arguments: ["reset", "ScreenCapture", id] });
        return (await proc.wait()).exitCode === 0;
      } catch (e) {
        console.warn("[settings] screen sharing not repaired:", e);
        return false;
      }
    },
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
      if (!cancel.data) Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
      // attemptingQuit: every window agreed to close (shuttingDown waits for them to be closed).
      if (!cancel.data && Services.startup.attemptingQuit) {
        if (Services.env.get("RESSAC_TEST_NO_RESTART") !== "1") relaunchAfterQuit();
        return true;
      }
      await IOUtils.remove(marker, { ignoreAbsent: true });
      return false;
    },
  };
}
