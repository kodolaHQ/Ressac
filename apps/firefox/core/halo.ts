/** How long the halo stays lit after the agent's last tool on the tab ends: back-to-back calls read as one work. */
export const HALO_HOLD_MS = 1500;

/**
 * The agent's halo: on at once while a tool runs, off `holdMs` after it ends; `set` only on a change. `off` puts it
 * out at once (the page shown changed: the hold only bridges gaps between tools on the same page).
 */
export function createHalo(set: (on: boolean) => void, holdMs = HALO_HOLD_MS): { update(running: boolean): void; off(): void; dispose(): void } {
  let on = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    update(running) {
      if (running) {
        cancel();
        if (!on) set((on = true));
      } else if (on && !timer)
        timer = setTimeout(() => {
          timer = undefined;
          set((on = false));
        }, holdMs);
    },
    off() {
      cancel();
      if (on) set((on = false));
    },
    dispose: cancel,
  };
}
