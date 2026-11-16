import { format } from "../shared/i18n";
import type { UpdatePhase, UpdateShown } from "../shared/model";

/** AppUpdater.STATUS key names (toolkit/mozapps/update/AppUpdater.sys.mjs) → what Ressac shows. */
const PHASES: Record<string, UpdatePhase> = {
  CHECKING: "checking",
  DOWNLOADING: "downloading",
  STAGING: "downloading",
  READY_FOR_RESTART: "ready",
  DOWNLOAD_FAILED: "failed",
  CHECKING_FAILED: "unreachable",
  INTERNAL_ERROR: "failed",
  NO_UPDATER: "disabled",
  UNSUPPORTED_SYSTEM: "disabled",
  UPDATE_DISABLED_BY_POLICY: "disabled",
  OTHER_INSTANCE_HANDLING_UPDATES: "disabled",
  // The app folder is not writable: only a manual download can update it.
  MANUAL_UPDATE: "unwritable",
};

/** NEVER_CHECKED, NO_UPDATES_FOUND, DOWNLOAD_AND_INSTALL (auto mode downloads by itself) and unknown keys are "idle". */
export function updatePhase(appUpdaterStatus: string): UpdatePhase {
  return Object.hasOwn(PHASES, appUpdaterStatus) ? PHASES[appUpdaterStatus]! : "idle";
}

export const showUpdateCard = (u: UpdateShown | null): boolean => u?.phase === "ready" && !u.dismissed;

/** The updater's MAR security error codes (common/updatererrors.h, 17-23): a signature, channel or version refusal. */
export const isSignatureFailure = (errorCode: number): boolean => errorCode >= 17 && errorCode <= 23;

/**
 * An offered update no newer than the running Ressac (an unpublished build gets the published one, same Gecko version,
 * other build ID): Firefox would install it, a downgrade. `compare` is Services.vc.compare.
 */
export const isStaleUpdate = (phase: UpdatePhase, version: string | null, running: string, compare: (a: string, b: string) => number): boolean =>
  (phase === "downloading" || phase === "ready") && !!version && compare(version, running) <= 0;

/** CFBundleShortVersionString of an Info.plist (XML): the staged app's own Ressac version, signed inside the MAR. */
export function plistVersion(plist: string): string | null {
  return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim() ?? null;
}

export const updateCardTitle = (version: string | null, locale: string): string =>
  version ? format(locale, "sidebar-update-title", { version }) : format(locale, "sidebar-update-title-plain");

/** Réglages › À propos. Unwritable shows only the DMG link. */
export function updateStatusText(u: UpdateShown, locale: string): string {
  const say = (id: string, args?: Record<string, string | number>) => format(locale, id, args);
  switch (u.phase) {
    case "idle":
      return say("sidebar-update-idle");
    case "checking":
      return say("sidebar-update-checking");
    case "downloading": {
      const text = u.version ? say("sidebar-update-downloading-version", { version: u.version }) : say("sidebar-update-downloading");
      return u.progress === null ? text : `${text} ${u.progress} %`;
    }
    case "ready":
      return u.version ? say("sidebar-update-ready-version", { version: u.version }) : say("sidebar-update-ready");
    case "unreachable":
      return say("sidebar-update-unreachable");
    case "failed":
      return say("sidebar-update-failed");
    default:
      return "";
  }
}

/**
 * The latest DMG sits next to the update feed (scripts/publish.sh): `<host>/updates/<key>/browser/…/update.xml` gives
 * `<host>/updates/<key>/Ressac.dmg`. The key is set at package time only, so the link is not in the code.
 */
export const updateDownloadUrl = (feedUrl: string): string => feedUrl.replace(/\/browser\/.*$/, "/Ressac.dmg");
