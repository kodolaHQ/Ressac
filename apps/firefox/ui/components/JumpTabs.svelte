<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { HINT_KEYS, hintLabels } from "../../shared/hint-labels";
  import { api } from "../state.svelte";

  /**
   * Jump to a tab (⌘E, vim's T): a letter on each tab the sidebar shows (essentials, pinned, the space's tabs); typing it
   * clicks that row, so each kind opens as a click would (an essential through its favorite). Escape, any other key, a
   * click or the window losing focus closes. Mounted inside the sidebar's column: the letters slide with it in compact mode.
   */
  let { close }: { close: () => void } = $props();

  type Hint = { label: string; row: HTMLElement; top: number; left: number };
  let layer: HTMLElement;
  let hints = $state.raw<Hint[]>([]);
  let typed = $state("");

  // The clickable rows, in order: essentials' cells, pinned favorites, tabs (the folders' name field and the « à vous » tag excluded).
  const ROWS = '[data-testid^="favorite-"]:not([data-testid="favorite-name"]), li[data-testid^="tab-"]';

  onMount(() => {
    const column = layer.parentElement!;
    const box = layer.getBoundingClientRect();
    // Only the rows on screen: a folded folder's favorites and tabs scrolled out of the tab list (its own clipping box) get no letter.
    const rows = [...column.querySelectorAll<HTMLElement>(ROWS)].filter((r) => {
      const b = r.getBoundingClientRect();
      const clip = (r.closest(".scrolling") ?? layer).getBoundingClientRect();
      return b.height > 0 && b.top >= clip.top - 1 && b.bottom <= clip.bottom + 1;
    });
    if (!rows.length) return close();
    const labels = hintLabels(rows.length);
    hints = rows.map((row, i) => {
      const b = row.getBoundingClientRect();
      return { label: labels[i]!, row, top: b.top - box.top + b.height / 2, left: b.left - box.left + 4 };
    });
    // The shortcut gave the keyboard to the sidebar: a key-driven exit hands it back to the shown web page.
    const leave = () => {
      close();
      api.returnFocusToPage();
    };
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || ["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (e.key === "Backspace") typed = typed.slice(0, -1);
      else if (e.metaKey || e.ctrlKey || e.altKey || k.length !== 1 || !HINT_KEYS.includes(k)) return leave();
      else typed += k;
      const hit = hints.find((h) => h.label === typed);
      if (hit) {
        close();
        hit.row.click();
        api.returnFocusToPage();
      } else if (!hints.some((h) => h.label.startsWith(typed))) leave();
    };
    const away = () => close();
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", away, true);
    window.addEventListener("blur", away);
    // A scroll moves the rows under their letters.
    window.addEventListener("wheel", away, { capture: true, passive: true });
    return () => {
      window.removeEventListener("wheel", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("blur", away);
    };
  });
</script>

<div class="jump" bind:this={layer} data-testid="jump-tabs" aria-hidden="true" out:fade={{ duration: 150 }}>
  {#each hints as h (h.label)}
    {#if h.label.startsWith(typed)}
      <span class="hint" data-testid="jump-hint" data-row={h.row.dataset.testid} style:top="{h.top}px" style:left="{h.left}px" out:fade={{ duration: 100 }}><b>{typed}</b>{h.label.slice(typed.length)}</span>
    {/if}
  {/each}
</div>

<style>
  .jump { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
  .hint {
    position: absolute;
    transform: translateY(-50%);
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--sheet) 86%, transparent);
    box-shadow: var(--float);
    color: var(--accent);
    font: 600 11px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.02em;
    animation: in 460ms linear(0, 0.06 2.4%, 0.24 5.1%, 0.55 9.4%, 0.84 14.6%, 1.01 19.4%, 1.07 23.2%, 1.08 26.6%, 1.05 32.8%, 1 41%, 0.99 50%, 1);
  }
  .hint b { font-weight: 500; opacity: 0.45; }
  @keyframes in { from { opacity: 0; transform: translateY(-50%) scale(0.85); } to { opacity: 1; transform: translateY(-50%) scale(1); } }
  @media (prefers-reduced-motion: reduce) { .hint { animation: none; } }
</style>
