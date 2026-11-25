import { SENSITIVE_HOSTS } from "../../../../packages/kernel/src/access/sensitive";

const LIST = "extensions.quarantinedDomains.list";
const ENABLED = "extensions.quarantinedDomains.enabled";

/**
 * The hosts Firefox's quarantine keeps extensions out of: the static sensitive list and its www. (Firefox matches exact
 * hosts). Static on purpose: past 4096 characters Gecko stops sending the pref to content processes. An add-on the user
 * exempts in about:addons (« Exécuter sur les sites avec restrictions ») runs there anyway: their choice.
 */
export function quarantineHosts(): string[] {
  return [...new Set(SENSITIVE_HOSTS.flatMap((h) => [h, `www.${h}`]))].sort();
}

const entries = () =>
  Services.prefs
    .getStringPref(LIST, "")
    .split(",")
    .map((h: string) => h.trim())
    .filter(Boolean);

let on = false;
let observing = false;
// On: quarantine enabled, our hosts merged with the user's own entries, put back at once if either pref is edited.
const sync = () => {
  if (!on) return;
  if (!Services.prefs.getBoolPref(ENABLED, false)) Services.prefs.setBoolPref(ENABLED, true);
  const current = entries();
  const merged = [...new Set([...current, ...quarantineHosts()])];
  if (merged.length !== current.length) Services.prefs.setStringPref(LIST, merged.join(","));
};

/**
 * Réglages › Confidentialité's « Quarantaine des extensions » (on by default). Off: our hosts leave the list (an entry
 * the user also typed in about:config that is one of them goes too: they cannot be told apart) and the switch goes
 * back to Firefox's own value.
 */
export function applyQuarantine(enabled: boolean): void {
  if (!observing) {
    observing = true;
    Services.prefs.addObserver(LIST, sync);
    Services.prefs.addObserver(ENABLED, sync);
  }
  on = enabled;
  if (on) return sync();
  const ours = new Set(quarantineHosts());
  const current = entries();
  const kept = current.filter((h: string) => !ours.has(h));
  // Already clean (off at a previous launch): the user's own prefs are left alone.
  if (kept.length === current.length) return;
  if (kept.join(",") === Services.prefs.getDefaultBranch("").getStringPref(LIST, "")) Services.prefs.clearUserPref(LIST);
  else Services.prefs.setStringPref(LIST, kept.join(","));
  Services.prefs.clearUserPref(ENABLED);
}
