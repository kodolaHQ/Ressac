import type { HintId } from "../../shared/hints";
import { api, appState } from "../state.svelte";

/** Marks a hint seen; no dispatch when it already is (gestures call this at every use). */
export function markSeen(id: HintId): void {
  const h = appState.value?.settings.hints;
  if (h && !h.seen.includes(id)) void api.dispatch({ type: "markHintSeen", id });
}

/** The one-time note of a surface is due: hints on, welcome over, not seen yet. */
export function firstTimePending(id: HintId): boolean {
  const s = appState.value?.settings;
  return !!s && s.hints.enabled && s.onboarded !== false && !s.hints.seen.includes(id);
}
