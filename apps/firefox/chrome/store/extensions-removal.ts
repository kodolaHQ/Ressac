const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");

/** Set once the agent's add-ons are gone: the cleanup runs at one launch only. */
const DONE = "ressac.agentExtensionsRemoved";
const SUFFIX = "@agent.ressac";
const EXEMPT = "extensions.quarantineIgnoredByUser.";

/**
 * Once, at the first launch without agent-written extensions (0.1.27): the agent's add-ons installed in Firefox and
 * their quarantine exemptions. The user's own add-ons are never touched. A failure is tried again at the next launch.
 */
export async function removeAgentAddons(): Promise<void> {
  if (Services.prefs.getBoolPref(DONE, false)) return;
  await AddonManager.readyPromise;
  for (const a of await AddonManager.getAddonsByTypes(["extension"])) if (a.id.endsWith(SUFFIX)) await a.uninstall();
  for (const pref of Services.prefs.getChildList(EXEMPT)) if (pref.endsWith(SUFFIX)) Services.prefs.clearUserPref(pref);
  Services.prefs.setBoolPref(DONE, true);
}
