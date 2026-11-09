<script lang="ts">
  import type { DesignState } from "../shared/api";
  import { access, accessOf } from "./access.svelte";
  import AccessBadge from "./components/AccessBadge.svelte";

  /** `app:<folder>`: the only id whose access this view shows. */
  let { id }: { id: string } = $props();
  const appState = $derived(accessOf(id));
  const api = window.webaios as unknown as import("../shared/api").ApiPastille;
  let menuOpen = $state(false);
  let design = $state<DesignState | null>(null);
  let root = $state<HTMLElement>();
  // The view grows while the bubble or the menu is open, and only gets in the app's way during that time.
  $effect(() => api.pastilleTaille(access.bullesOuvertes > 0 || menuOpen));

  async function toggleMenu() {
    menuOpen = !menuOpen;
    if (menuOpen) design = await api.design.etat().catch(() => null);
  }
  function choose(act: () => void) {
    menuOpen = false;
    act();
  }
  function dehors(e: PointerEvent) {
    if (menuOpen && !root?.contains(e.target as Node)) menuOpen = false;
  }
</script>

<svelte:window onpointerdown={dehors} onblur={() => (menuOpen = false)} onkeydown={(e) => e.key === "Escape" && (menuOpen = false)} />

<main>
  <div class="ligne">
    {#if appState}<AccessBadge {id} etat={appState} />{/if}
    <span class="webaios" bind:this={root}>
      <button class="pastille" data-testid="pastille-webaios" aria-label="WebAiOs" aria-haspopup="menu" aria-expanded={menuOpen} onclick={toggleMenu}>✎</button>
      {#if menuOpen}
        <div class="menu" role="menu">
          <button role="menuitem" class:actif={design?.actif} onclick={() => choose(() => api.design.basculer())}>Mode design <kbd>⌘⇧D</kbd></button>
          <button role="menuitem" onclick={() => choose(() => api.design.panier())}>Panier ({design?.panier ?? 0})</button>
          <button role="menuitem" onclick={() => choose(() => api.design.relire())}>Relire ce projet</button>
        </div>
      {/if}
    </span>
  </div>
</main>

<style>
  main { display: flex; justify-content: flex-end; align-items: flex-start; height: 100%; }
  .ligne { display: flex; align-items: center; gap: 6px; height: 28px; }
  .webaios { position: relative; display: inline-flex; }
  .pastille { all: unset; display: grid; place-content: center; width: 40px; height: 24px; border-radius: 999px; background: var(--fond-actif); color: var(--texte); font-size: 12px; cursor: pointer; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35); }
  .pastille[aria-expanded="true"] { color: var(--accent); }
  .menu { position: absolute; right: 0; top: 30px; width: 200px; padding: 4px; background: var(--fond-actif); border: 1px solid var(--bord); border-radius: 6px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35); }
  .menu button { all: unset; display: flex; justify-content: space-between; box-sizing: border-box; width: 100%; padding: 5px 6px; border-radius: 4px; color: var(--texte); cursor: pointer; font-size: 13px; }
  .menu button:hover { background: var(--fond-survol); }
  .menu button.actif { color: var(--accent); }
  kbd { font: inherit; color: var(--texte-doux); }
</style>
