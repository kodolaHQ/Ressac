import { api } from "../state.svelte";

/**
 * Command bar (⌘T, ⌘L). `mode`: "nouveau" opens in a new tab, "actif" replaces the active tab's page. `texte`:
 * starting input. Each opening creates a new object: reopening midway resets the input.
 */
export const command = $state<{ ouverte: null | { mode: "nouveau" | "actif"; texte: string } }>({ ouverte: null });

export function openCommand(mode: "nouveau" | "actif", text = ""): void {
  command.ouverte = { mode, texte: text };
}

/**
 * Counter the empty page watches: each increase gives it the keyboard back (on home, there is no native view to give
 * it to). No effect when the empty page is not mounted (a tab or a panel is shown).
 */
export const focusEmptyPage = $state({ n: 0 });

/** `rendreFocus`: the keyboard returns to the shown page (Escape, click on the veil, validation) or to the home field. */
export function closeCommand(returnFocus = false): void {
  if (!command.ouverte) return;
  command.ouverte = null;
  if (returnFocus) {
    api.rendreFocusPage();
    focusEmptyPage.n++;
  }
}
