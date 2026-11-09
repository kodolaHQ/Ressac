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
  class="essentiels"
  class:grand={large}
  data-testid={large ? "essentiels-page-vide" : "essentiels"}
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
      data-testid="favori-{favorite.id}"
      class:actif={favorite.id === active}
      title={favorite.title}
      onclick={() => open(favorite)}
      oncontextmenu={(e) => openMenu(e, [{ label: "Retirer", dispatch: () => api.dispatch({ type: "removeEssential", favoriteId: favorite.id }) }])}
    >
      <SiteIcon favicon={favorite.favicon} title={favorite.title} size={large ? 32 : 18} />
    </button>
  {/each}
</div>

<style>
  .essentiels { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; min-height: 8px; }
  .essentiels.grand { grid-template-columns: repeat(auto-fill, 64px); justify-content: center; gap: 12px; }
  button { all: unset; display: grid; place-content: center; height: 44px; border-radius: 10px; background: var(--fond-survol); }
  .grand button { height: 64px; }
  /* Inside the box: the sidebar's scroll area clips what sticks out. */
  button.actif { background: var(--fond-actif); outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
