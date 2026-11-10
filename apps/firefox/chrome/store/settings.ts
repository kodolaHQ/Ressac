import { backupDate, RESET_FILE } from "../../core/state/format";

const ENABLED = "webaios.telemetry.enabled";
const EXPORT_NAME = /^WebAiOs-donnees-\d{4}-\d{2}-\d{2}( \(\d+\))?\.zip$/;

export interface SettingsChrome {
  telemetry(): { available: boolean; enabled: boolean };
  setTelemetry(enabled: boolean): void;
  version(): string;
  reveal(path: string): void;
  exportFolder(): Promise<string>;
  reset(): Promise<void>;
}

/** What « Afficher dans le Finder » may show: the data folder, a backup, or an export file directly in the export folder. */
export function revealable(dataDir: string, exportFolder: string, path: string): boolean {
  if (typeof path !== "string" || path.includes("\0")) return false;
  if (path === dataDir || backupDate(dataDir, path) !== null) return true;
  if (!exportFolder || !path.startsWith(exportFolder + "/")) return false;
  return EXPORT_NAME.test(path.slice(exportFolder.length + 1));
}

export function createSettingsChrome(dataDir: string, telemetryActive: boolean): SettingsChrome {
  let lastExportFolder = "";
  return {
    telemetry: () => ({ available: telemetryActive, enabled: Services.prefs.getBoolPref(ENABLED, false) }),
    setTelemetry: (enabled) => Services.prefs.setBoolPref(ENABLED, enabled === true),
    version: () => Services.appinfo.version,
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
    async exportFolder() {
      const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
      return (lastExportFolder = await Downloads.getPreferredDownloadsDirectory());
    },
    async reset() {
      await IOUtils.writeUTF8(PathUtils.join(dataDir, RESET_FILE), "");
      const quit = Ci.nsIAppStartup.eAttemptQuit | (Services.env.get("WEBAIOS_TEST_NO_RESTART") === "1" ? 0 : Ci.nsIAppStartup.eRestart);
      Services.startup.quit(quit);
    },
  };
}
