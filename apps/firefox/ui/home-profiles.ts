import type { ProfileForGrant } from "../shared/api";
import type { BrowserState, ProfileId, WindowId } from "../shared/model";

// Pure rules of the reads and the home page: the sidebar bundle cannot import
// node:net.

/** The sign-in profiles a read may use: those of the state that no private space uses. */
export function readableProfiles(appState: Pick<BrowserState, "profiles" | "spaces">): string[] {
  const privates = new Set(appState.spaces.filter((e) => e.private).map((e) => e.profile));
  return appState.profiles.map((p) => p.id).filter((id) => !privates.has(id));
}

/** Formats a message in the shown language. Passed in: the host also imports this module and must not load Fluent. */
export type Say = (id: string, args?: Record<string, string>) => string;

/** « Profile of « Personal, Work » » (the spaces that use it), or « Profile « id » » with no space. */
export function profileLabel(state: Pick<BrowserState, "spaces">, id: ProfileId, say: Say): string {
  const spaces = state.spaces.filter((e) => e.profile === id).map((e) => e.name);
  return spaces.length ? say("home-profile-of", { spaces: spaces.join(", ") }) : say("home-profile", { id });
}

/**
 * The profiles a grant may use: never a private space's (even shared with a non-private space).
 * Checked by default: the window's active space's, if it is readable.
 */
export function profilesForGrant(appState: Pick<BrowserState, "profiles" | "spaces" | "windows">, windowId: WindowId | undefined, say: Say): ProfileForGrant[] {
  const win = appState.windows.find((f) => f.id === windowId);
  const active = win ? appState.spaces.find((e) => e.id === win.activeSpace)?.profile : undefined;
  return readableProfiles(appState).map((id) => {
    return { id, label: profileLabel(appState, id, say), isDefault: id === active };
  });
}

/** Copy of `isIP` (chrome/shims/net.ts): 4 or 6 only, without node:net. */
const isIp = (h: string): 0 | 4 | 6 => (/^(\d{1,3}\.){3}\d{1,3}$/.test(h) ? 4 : h.includes(":") && /^[0-9a-f:.]+$/i.test(h) ? 6 : 0);

/** Copy of `adresseLocale` (packages/kernel/src/workflows/acces.ts). */
export function localUrl(hostName: string): boolean {
  const h = hostName.replace(/^\[|\]$/g, "").toLowerCase().replace(/(?<!\.)\.+$/, "");
  if (!h || h === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(h)) return true;
  if (isIp(h) === 4) {
    const [a = 0, b = 0] = h.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (isIp(h) === 6) return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:") || h.startsWith("64:ff9b:");
  return false;
}

/** Only a widget's http(s) link opens: no `javascript:`, no `file:`, no machine address (openableUrl). */
export function openableUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && !localUrl(u.hostname);
}
