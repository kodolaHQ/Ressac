<script lang="ts">
  import { closeMenu, menu } from "./menu.svelte";
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && closeMenu()} onclick={closeMenu} onblur={closeMenu} />

{#if menu.ouvert}
  <!-- Stays in the sidebar (the web view would cover a menu that overflows onto the content), except on an internal page. -->
  {@const enBas = menu.ouvert.y > window.innerHeight / 2}
  <div
    class="menu"
    role="menu"
    style:left="{Math.min(menu.ouvert.x, (menu.ouvert.libre ? window.innerWidth : 240) - 170)}px"
    style:top={enBas ? undefined : `${menu.ouvert.y}px`}
    style:bottom={enBas ? `${window.innerHeight - menu.ouvert.y}px` : undefined}
  >
    {#each menu.ouvert.entrees as entree (entree.libelle)}
      <button
        role="menuitem"
        onclick={(e) => {
          e.stopPropagation();
          closeMenu();
          entree.agir();
        }}>{entree.libelle}</button
      >
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 10;
    width: 160px;
    padding: 4px;
    background: var(--fond-actif);
    border: 1px solid var(--bord);
    border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
    -webkit-app-region: no-drag;
  }
  button {
    all: unset;
    display: block;
    width: calc(100% - 12px);
    padding: 5px 6px;
    border-radius: 4px;
    color: var(--texte);
  }
  button:hover { background: var(--fond-survol); }
</style>
