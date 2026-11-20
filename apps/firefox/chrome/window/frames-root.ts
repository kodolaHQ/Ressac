// The agent-written frames (widget displays, site-app homes, action components) are copies under
// `<profile>/chrome/ressac-frames/<kind>/`, served by ONE resource:// substitution whose host carries a per-launch
// random token, so a web page cannot guess any frame's address.
export const FRAMES_GROUP = "ressac-frames";
/** The sharedData key the parent sets in a dev build with RESSAC_TEST_FRAMES: the frame actor's test hook reads it, a page cannot write it. */
export const FRAMES_TEST_KEY = "ressac-frames-test";

let token: string | undefined;
/** 16 hex chars, drawn once per process. */
export function framesToken(): string {
  // This module is bundled in the store and in each window's UI: a UI copy (it has a `window`) takes the store's token.
  token ??=
    typeof window === "undefined"
      ? Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")
      : (ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").framesToken() as string);
  return token;
}

export const framesHost = (): string => `${FRAMES_GROUP}-${framesToken()}`;
export const framesOrigin = (): string => `resource://${framesHost()}`;
export const framesDir = (): string => PathUtils.join(PathUtils.profileDir, "chrome", FRAMES_GROUP);
export const framesKindDir = (kind: "widgets" | "sites" | "components"): string => PathUtils.join(framesDir(), kind);

let substituted = false;
/** Points the substitution at framesDir(), content-accessible (a remote frame loads from it); idempotent. */
export function ensureFramesSubstitution(): void {
  if (substituted) return;
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler)
    .setSubstitutionWithFlags(framesHost(), Services.io.newFileURI(new FileUtils.File(framesDir())), Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS);
  substituted = true;
}

/** The copies are a disposable cache: wiped at startup, so none made by an older sanitizer is ever served. */
export async function wipeFrames(): Promise<void> {
  await IOUtils.remove(framesDir(), { recursive: true, ignoreAbsent: true });
}
