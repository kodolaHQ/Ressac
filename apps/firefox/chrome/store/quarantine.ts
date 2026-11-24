import { SENSITIVE_HOSTS } from "../../../../packages/kernel/src/access/sensitive";

const LIST = "extensions.quarantinedDomains.list";
const ENABLED = "extensions.quarantinedDomains.enabled";

/**
 * The hosts Firefox's quarantine keeps the agent's extensions out of: the static sensitive list and its www. (Firefox matches
 * exact hosts). Static on purpose: past 4096 characters Gecko stops sending the pref to content processes, and every host
 * added blocks the user's own add-ons there too. Subdomains and sensitive paths are refused by the parent checkpoint (hostAllowed).
 */
export function quarantineHosts(): string[] {
  return [...new Set(SENSITIVE_HOSTS.flatMap((h) => [h, `www.${h}`]))].sort();
}

/** Quarantine on, our hosts merged with the user's own entries; put back at once if either pref is edited. */
export function installQuarantine(): void {
  const ours = quarantineHosts();
  const sync = () => {
    if (!Services.prefs.getBoolPref(ENABLED, false)) Services.prefs.setBoolPref(ENABLED, true);
    const current = Services.prefs
      .getStringPref(LIST, "")
      .split(",")
      .map((h: string) => h.trim())
      .filter(Boolean);
    const merged = [...new Set([...current, ...ours])];
    if (merged.length !== current.length) Services.prefs.setStringPref(LIST, merged.join(","));
  };
  sync();
  Services.prefs.addObserver(LIST, sync);
  Services.prefs.addObserver(ENABLED, sync);
}
