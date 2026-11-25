import { testEnv } from "../test-env";

/**
 * Touch ID (or the Mac's password) after a masking card's « Oui », before its answer goes back (spec § 5.2). Anything
 * but a real success is a no: a cancel, an error, another prompt already pending. `RESSAC_TEST_REAUTH` (dev builds only):
 * `pass` stands in for a success, any other value for a failure, so an e2e never waits on the macOS prompt.
 */
/** Only a real success: `success_no_password` (a Mac with no login password) would let anyone press « Oui ». */
export const reauthAccepted = (r: { authenticated?: boolean; auth_details?: string } | null | undefined): boolean =>
  r?.authenticated === true && r.auth_details === "success";

export async function reauth(reason: string, parent: Window | null = null): Promise<boolean> {
  const seam = testEnv("RESSAC_TEST_REAUTH");
  if (seam !== undefined) return seam === "pass";
  try {
    const { OSKeyStore } = ChromeUtils.importESModule("resource://gre/modules/OSKeyStore.sys.mjs");
    // OSKeyStore hands a pending unlock's result to every caller: one started without a prompt would answer for this one.
    if (OSKeyStore.isUIBusy) return false;
    // No key generated (false): only the prompt is wanted. A platform without a prompt, or a Mac with no password, reports a success it did not ask.
    const r = await OSKeyStore.ensureLoggedIn(reason, "Ressac", parent, false);
    return reauthAccepted(r);
  } catch (e) {
    console.error("[ressac] reauth failed:", (e as Error)?.name);
    return false;
  }
}
