<script lang="ts">
  import type { WindowState, Favorite } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import SiteIcon from "./SiteIcon.svelte";
  import { openMenu } from "./menu.svelte";

  let { window: win, large: large = false }: { window: WindowState; large?: boolean } = $props();
  const active = $derived.by(() => {
    const id = win.active[win.activeSpace];
    return id ? appState.value?.tabs[id]?.link?.id : undefined;
  });

  function open(f: Favorite) {
    api.dispatch({ type: "openFavorite", windowId: win.id, kind: "essential", id: f.id });
  }
</script>

<div
  class="essentials"
  class:large={large}
  data-testid={large ? "essentials-empty-page" : "essentials"}
  role="group"
  aria-label="Essentiels"
  ondragover={(e) => e.dataTransfer?.types.includes("application/x-webaios-onglet") && e.preventDefault()}
  ondrop={(e) => {
    const id = e.dataTransfer?.getData("application/x-webaios-onglet");
    if (id) api.dispatch({ type: "addEssential", id });
  }}
>
  {#each appState.value?.essentials ?? [] as favorite (favorite.id)}
    <button
      data-testid="favorite-{favorite.id}"
      class:active={favorite.id === active}
      title={favorite.title}
      onclick={(e) => e.button === 0 && open(favorite)}
      oncontextmenu={(e) => openMenu(e, [{ label: "Retirer", dispatch: () => api.dispatch({ type: "removeEssential", favoriteId: favorite.id }) }])}
    >
      <SiteIcon favicon={favorite.favicon} title={favorite.title} size={large ? 32 : 18} />
    </button>
  {/each}
</div>

<style>
  .essentials { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; min-height: 8px; }
  .essentials.large { grid-template-columns: repeat(auto-fill, 64px); justify-content: center; gap: 12px; }
  button { all: unset; display: grid; place-content: center; height: 44px; border-radius: 12px; background: color-mix(in srgb, var(--glass-hi) 60%, transparent); box-shadow: inset 0 0 0 1px var(--glass-edge); transition: transform var(--tap), background var(--tap), box-shadow var(--tap); }
  button:hover { background: var(--glass-hi); }
  button:active { transform: scale(0.97); }
  .large button { height: 64px; border-radius: 16px; }
  /* Inside the box: the sidebar's scroll area clips what sticks out. */
  button.active { background: var(--glass-hi); box-shadow: inset 0 0 0 1.5px var(--accent); }
</style>
