import type { SettingsSection } from "../../shared/commands";

// Module-level: the page is remounted on each tab switch and comes back to the last section seen.
let current = $state<SettingsSection>("general");
export const currentSection = () => current;
/** Called before opening Réglages from elsewhere: the Extensions page lands on Agent, ⌘T's « Réglages › … » on its section. */
export const showSection = (id: SettingsSection) => (current = id);
