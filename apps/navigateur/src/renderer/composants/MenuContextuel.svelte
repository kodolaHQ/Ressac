<script lang="ts">
  import { fermerMenu, menu } from "./menu.svelte";
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && fermerMenu()} onclick={fermerMenu} onblur={fermerMenu} />

{#if menu.ouvert}
  <!-- Reste dans la barre latérale : la vue web couvrirait un menu qui déborde sur le contenu. -->
  {@const enBas = menu.ouvert.y > window.innerHeight / 2}
  <div
    class="menu"
    role="menu"
    style:left="{Math.min(menu.ouvert.x, 240 - 170)}px"
    style:top={enBas ? undefined : `${menu.ouvert.y}px`}
    style:bottom={enBas ? `${window.innerHeight - menu.ouvert.y}px` : undefined}
  >
    {#each menu.ouvert.entrees as entree (entree.libelle)}
      <button
        role="menuitem"
        onclick={(e) => {
          e.stopPropagation();
          fermerMenu();
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
