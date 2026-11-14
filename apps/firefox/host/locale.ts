import { say } from "../../../packages/kernel/src/i18n.ts";

// The language the interface shows, kept here so host modules read it without importing host.ts (circular).
let current = "fr";
export const hostLocale = (): string => current;
export const setHostLocale = (l: string): void => void (current = l);
/** A host text in the shown language. */
export const hostSay = (id: string, args?: Record<string, string | number>): string => say(current, id, args);
