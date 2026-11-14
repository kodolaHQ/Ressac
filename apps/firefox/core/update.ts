import type { UpdatePhase, UpdateShown } from "../shared/model";

/** AppUpdater.STATUS key names (toolkit/mozapps/update/AppUpdater.sys.mjs) → what Ressac shows. */
const PHASES: Record<string, UpdatePhase> = {
  CHECKING: "checking",
  DOWNLOADING: "downloading",
  STAGING: "downloading",
  READY_FOR_RESTART: "ready",
  DOWNLOAD_FAILED: "failed",
  CHECKING_FAILED: "failed",
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
