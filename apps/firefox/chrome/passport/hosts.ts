// The « Remplissable sur » hosts of every passport the chrome loaded or saved (ruling F28): the agent's extensions never
// reach them. Fed by the passport files (store.ts) as they load, save and remove; read by chrome/store/agent-extensions.ts.
const byProfile = new Map<string, readonly string[]>();
/** Set once the first push's loads settled: before, every host counts as a passport's (fail closed). */
let known = false;

export function passportHostsKnown(): void {
  known = true;
}

export function setPassportHosts(profile: string, entries: readonly { origins: readonly string[] }[]): void {
  const hosts = entries.flatMap((e) => e.origins);
  if (hosts.length) byProfile.set(profile, hosts);
  else byProfile.delete(profile);
}

/** The address is on a passport host or its `www.` (as originMatches reads an origin), whatever its scheme; any address while the hosts are not known yet. */
export function onPassportHost(url: string): boolean {
  if (!known) return true;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  return [...byProfile.values()].some((hosts) => hosts.some((h) => host === h || host === `www.${h}`));
}
