import { format } from "../shared/i18n";
import { appState } from "./state.svelte";

/** A message in the shown language; reading the state makes templates re-render when the language changes. */
export const t = (id: string, args?: Record<string, string | number | Date>): string => format(appState.value?.locale ?? "fr", id, args);
