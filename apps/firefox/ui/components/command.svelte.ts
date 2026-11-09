import { api } from "../state.svelte";

/**
 * Command bar (⌘T, ⌘L). `mode`: "new" opens in a new tab, "active" replaces the active tab's page. `texte`:
 * starting input. Each opening creates a new object: reopening midway resets the input.
 */
export const command = $state<{ open: null | { mode: "new" | "active"; text: string } }>({ open: null });

export function openCommand(mode: "new" | "active", text = ""): void {
  command.open = { mode, text: text };
}

/**
 * Counter the empty page watches: each increase gives it the keyboard back (on home, there is no native view to give
 * it to). No effect when the empty page is not mounted (a tab or a panel is shown).
 */
export const focusEmptyPage = $state({ n: 0 });

/** `rendreFocus`: the keyboard returns to the shown page (Escape, click on the veil, validation) or to the home field. */
export function closeCommand(returnFocus = false): void {
  if (!command.open) return;
  command.open = null;
  if (returnFocus) {
    api.returnFocusToPage();
    focusEmptyPage.n++;
  }
}
