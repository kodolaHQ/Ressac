<script lang="ts">
  import type { ApiSite, DesignState } from "../../shared/api";
  import type { SiteWindowState } from "../../shared/sites";

  // The app's design mode (plan 18): ✎ (⌘⇧D), its counter, and the « Panier » / « Relire ce projet » chevron. A list
  // under the bar would be hidden by the site's view: both entries unfold in the bar, in place of the title
  // (`menuOuvert`, read by the bar), and fold back on choice, on Escape, on a click elsewhere in the bar or after 5 s.
  let { api, state: appState, menuOpen: menuOpen = $bindable(false) }: { api: ApiSite; state: SiteWindowState; menuOpen?: boolean } = $props();
  const MENU_DURATION_MS = 5000;
  let design = $state<DesignState | null>(null);
  let root = $state<HTMLElement | null>(null);
  let reading = 0;

  async function reread(): Promise<void> {
    const n = ++reading;
    const e = await api.design.state().catch(() => null);
    if (n === reading) design = e;
  }

  // Re-read on each window state received (view, page, full screen…) and on each change of the mode or the basket.
  $effect(() => {
    void appState;
    void reread();
  });
  $effect(() => api.design.onChange(() => void reread()));

  const active = $derived(design?.active ?? false);
  const unavailable = $derived(!design || design.unavailable !== null);

  // Folds back by itself after 5 s.
  $effect(() => {
    if (!menuOpen) return;
    const timer = setTimeout(() => (menuOpen = false), MENU_DURATION_MS);
    return () => clearTimeout(timer);
  });

  function choose(act: () => void) {
    menuOpen = false;
    act();
  }
  function clickElsewhere(e: MouseEvent) {
    if (menuOpen && root && !(e.target instanceof Node && root.contains(e.target))) menuOpen = false;
  }
</script>

<svelte:window onkeydown={(e) => menuOpen && e.key === "Escape" && (menuOpen = false)} onclick={clickElsewhere} />

<span class="design" bind:this={root}>
  {#if menuOpen}
    <span class="entries" role="menu" aria-label="Mode design">
      <button role="menuitem" data-testid="site-menu-design-basket" onclick={() => choose(() => api.design.openBasket())}>Panier</button>
      <button role="menuitem" data-testid="site-menu-design-review" onclick={() => choose(() => api.design.review())}>Relire ce projet</button>
    </span>
  {/if}
  <button
    class="button"
    data-testid="site-design-button"
    aria-label="Mode design"
    aria-pressed={active}
    disabled={unavailable}
    title={unavailable ? (design?.unavailable ?? "") : "Mode design (⌘⇧D)"}
    onclick={() => api.design.toggle()}
    >✎{#if design && design.basket > 0}<span class="counter" data-testid="site-basket-counter">{design.basket}</span>{/if}</button
  >
  <!-- Always active: the basket and the review stay reachable where the mode does not start (home, card…). -->
  <button class="chevron" data-testid="site-menu-design" aria-label="Menu du mode design" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>▾</button>
</span>

<style>
  .design { display: inline-flex; align-items: center; gap: 2px; flex: none; -webkit-app-region: no-drag; }
  .entries { display: inline-flex; gap: 2px; margin-right: 4px; }
  button { all: unset; height: 24px; display: grid; grid-auto-flow: column; align-items: center; gap: 3px; border-radius: 5px; color: var(--text-muted); cursor: pointer; white-space: nowrap; -webkit-app-region: no-drag; }
  .entries button { padding: 0 8px; font-size: 12px; background: var(--bg-active); color: var(--text); }
  .button { padding: 0 6px; }
  .chevron { width: 14px; justify-content: center; font-size: 10px; }
  button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
  button:disabled { opacity: 0.35; cursor: default; }
  .button[aria-pressed="true"] { color: var(--accent); }
  .chevron[aria-expanded="true"] { background: var(--bg-hover); color: var(--text); }
  .counter { min-width: 14px; padding: 0 3px; box-sizing: border-box; border-radius: 7px; background: var(--accent); color: #fff; font-size: 10px; line-height: 14px; text-align: center; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
