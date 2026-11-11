<script lang="ts">
  // Gecko dispatches `click` for the right button too in chrome documents: only a left click closes the menu.
  import { appState } from "../state.svelte";
  import { closeMenu, menu } from "./menu.svelte";

  // On the right the sidebar iframe is as wide as the window or as the sidebar: its own width is the room.
  const right = $derived(appState.value?.settings.sidebarSide === "right");
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && closeMenu()} onclick={(e) => e.button === 0 && closeMenu()} onblur={closeMenu} />

{#if menu.open}
  <!-- Stays in the sidebar (the web view would cover a menu that overflows onto the content), except on an internal page. -->
  {@const atBottom = menu.open.y > window.innerHeight / 2}
  <div
    class="menu"
    role="menu"
    style:left="{Math.min(menu.open.x, (menu.open.free || right ? window.innerWidth : 240) - 170)}px"
    style:top={atBottom ? undefined : `${menu.open.y}px`}
    style:bottom={atBottom ? `${window.innerHeight - menu.open.y}px` : undefined}
  >
    {#each menu.open.inputs as entry (entry.label)}
      <button
        role="menuitem"
        onclick={(e) => {
          e.stopPropagation();
          closeMenu();
          entry.dispatch();
        }}>{entry.label}</button
      >
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: 10;
    width: 170px;
    padding: 5px;
    box-sizing: border-box;
    background: var(--glass-dense);
    backdrop-filter: blur(30px) saturate(1.8);
    border: 1px solid var(--glass-edge);
    border-radius: 12px;
    box-shadow: var(--modal-shadow);
    animation: webaios-drop var(--spring-d) var(--spring) backwards;
    -webkit-app-region: no-drag;
  }
  button {
    all: unset;
    display: block;
    width: calc(100% - 18px);
    padding: 7px 9px;
    border-radius: 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
    transition: transform var(--tap), background var(--tap);
  }
  button:hover { background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--glass-edge); }
  button:active { transform: scale(0.97); }
</style>
