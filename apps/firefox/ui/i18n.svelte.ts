import { format } from "../shared/i18n";
import { appState } from "./state.svelte";

/** A message in the shown language; reading the state makes templates re-render when the language changes. */
export const t = (id: string, args?: Record<string, string | number | Date>): string => format(appState.value?.locale ?? "fr", id, args);

/**
 * The message split around the variable `slot`, for markup inside a sentence (a <kbd>, a <b>): `[before, after]`, the
 * caller renders the value between them; the word order stays the translation's.
 */
export function tAround(id: string, slot: string, args: Record<string, string | number | Date> = {}): [string, string] {
  const MARK = "\u2063";
  const [before = "", after = ""] = t(id, { ...args, [slot]: MARK }).split(MARK);
  return [before, after];
}
