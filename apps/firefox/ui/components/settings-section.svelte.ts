import type { SettingsSection } from "../../shared/commands";

// Module-level: the page is remounted on each tab switch and comes back to the last section seen.
let current = $state<SettingsSection>("general");
export const currentSection = () => current;
/** The passport profile asked for by the last `showSection("passport", { profile })`, until the page takes it. */
let passportProfile = $state<string | null>(null);
export const requestedPassport = () => passportProfile;
export const takeRequestedPassport = () => void (passportProfile = null);
/** Run as the passport section is left, before any teardown (the page's relock never waits for a transition). */
let leavingPassport: (() => void) | null = null;
export const onLeavingPassport = (f: () => void) => {
  leavingPassport = f;
  return () => void (leavingPassport === f && (leavingPassport = null));
};
/** The same for Mots de passe: its tokens go as the section is left. */
let leavingPasswords: (() => void) | null = null;
export const onLeavingPasswords = (f: () => void) => {
  leavingPasswords = f;
  return () => void (leavingPasswords === f && (leavingPasswords = null));
};
/** Called before opening Réglages from elsewhere: the Extensions page lands on Agent, ⌘T's « Réglages › … » on its section. */
export const showSection = (id: SettingsSection, o: { profile?: string } = {}) => {
  if (current === "passport" && id !== "passport") leavingPassport?.();
  if (current === "passwords" && id !== "passwords") leavingPasswords?.();
  current = id;
  passportProfile = o.profile ?? null;
};
