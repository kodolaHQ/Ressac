<script lang="ts">
  import type { DesignState } from "../shared/api";
  import { access, accessOf } from "./access.svelte";
  import AccessBadge from "./components/AccessBadge.svelte";
  import { language, t } from "./i18n.svelte";

  /** `app:<folder>`: the only id whose access this view shows. */
  let { id }: { id: string } = $props();
  const appState = $derived(accessOf(id));
  const api = window.ressac as unknown as import("../shared/api").BadgeApi;
  let menuOpen = $state(false);
  let design = $state<DesignState | null>(null);
  let root = $state<HTMLElement>();
  // This frame has no browser state: it asks for the language when it loads and each time its menu opens.
  language.override = api.locale();
  // The view grows while the bubble or the menu is open, and only gets in the app's way during that time.
  $effect(() => api.badgeSize(access.openBubbles > 0 || menuOpen));

  async function toggleMenu() {
    menuOpen = !menuOpen;
    language.override = api.locale();
    if (menuOpen) design = await api.design.state().catch(() => null);
  }
  function choose(act: () => void) {
    menuOpen = false;
    act();
  }
  function outside(e: PointerEvent) {
    if (menuOpen && !root?.contains(e.target as Node)) menuOpen = false;
  }
</script>

<svelte:window onpointerdown={outside} onblur={() => (menuOpen = false)} onkeydown={(e) => e.key === "Escape" && (menuOpen = false)} />

<main>
  <div class="line">
    {#if appState}<AccessBadge {id} state={appState} />{/if}
    <span class="ressac" bind:this={root}>
      <button class="pill" data-testid="ressac-pill" aria-label="Ressac" aria-haspopup="menu" aria-expanded={menuOpen} onclick={toggleMenu}>✎</button>
      {#if menuOpen}
        <div class="menu" role="menu">
          <button role="menuitem" class:active={design?.active} onclick={() => choose(() => api.design.toggle())}>{t("chrome-site-design")} {#if design}<kbd>{design.shortcut}</kbd>{/if}</button>
          <button role="menuitem" onclick={() => choose(() => api.design.basket())}>{t("chrome-badge-basket", { count: String(design?.basket ?? 0) })}</button>
          <button role="menuitem" onclick={() => choose(() => api.design.review())}>{t("chrome-site-review")}</button>
        </div>
      {/if}
    </span>
  </div>
</main>

<style>
  main { display: flex; justify-content: flex-end; align-items: flex-start; height: 100%; }
  .line { display: flex; align-items: center; gap: 6px; height: 28px; }
  .ressac { position: relative; display: inline-flex; }
  .pill { all: unset; display: grid; place-content: center; width: 40px; height: 24px; border-radius: 999px; background: var(--glass-dense); border: 1px solid var(--glass-edge); box-sizing: border-box; color: var(--text); font-size: 12px; cursor: pointer; box-shadow: var(--float); transition: transform var(--tap), color var(--tap); }
  .pill:active { transform: scale(0.97); }
  .pill[aria-expanded="true"] { color: var(--accent); }
  /* Over the site: no blur reaches it, the dense glass keeps the menu readable. */
  .menu { position: absolute; right: 0; top: 30px; width: 210px; padding: 5px; background: var(--glass-dense); border: 1px solid var(--glass-edge); border-radius: 12px; box-shadow: var(--modal-shadow); transform-origin: top right; animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .menu button { all: unset; display: flex; align-items: center; justify-content: space-between; box-sizing: border-box; width: 100%; padding: 7px 9px; border-radius: 8px; color: var(--text); cursor: pointer; font-size: 13px; transition: transform var(--tap), background var(--tap); }
  .menu button:hover { background: var(--glass-hi); }
  .menu button:active { transform: scale(0.97); }
  .menu button.active { color: var(--accent); }
</style>
