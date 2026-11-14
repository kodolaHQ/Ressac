<script lang="ts">
  import type { WindowState, Favorite } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import SiteIcon from "./SiteIcon.svelte";
  import { openMenu } from "./menu.svelte";

  let { window: win }: { window: WindowState } = $props();
  const active = $derived.by(() => {
    const id = win.active[win.activeSpace];
    return id ? appState.value?.tabs[id]?.link?.id : undefined;
  });

  const MOVE = "application/x-ressac-essentiel";
  /** The essential under a dragged one: it shows where the drop lands. */
  let over = $state<string | null>(null);

  /** The icon of the essential's open tab in this window, which the site changes (unread count). */
  const tabOf = (f: Favorite) => Object.values(appState.value?.tabs ?? {}).find((t) => t.link?.id === f.id && t.windowId === win.id);

  function open(f: Favorite) {
    api.dispatch({ type: "openFavorite", windowId: win.id, kind: "essential", id: f.id });
  }
</script>

<div
  class="essentials"
  data-testid="essentials"
  role="group"
  aria-label={t("chrome-ui-essentials")}
  ondragover={(e) => e.dataTransfer?.types.includes("application/x-ressac-onglet") && e.preventDefault()}
  ondrop={(e) => {
    // An essential dropped back in its own grid (between two cells) stays one.
    if (e.dataTransfer?.types.includes(MOVE)) return e.stopPropagation();
    const id = e.dataTransfer?.getData("application/x-ressac-onglet");
    if (id) api.dispatch({ type: "addEssential", id });
  }}
>
  {#each appState.value?.essentials ?? [] as favorite, index (favorite.id)}
    <!-- A div, not a button: Firefox does not start a drag from a button. -->
    <div
      class="cell"
      role="button"
      tabindex="0"
      data-testid="favorite-{favorite.id}"
      class:active={favorite.id === active}
      class:over={favorite.id === over}
      class:unloaded={tabOf(favorite)?.unloaded}
      title={favorite.title}
      draggable="true"
      ondragstart={(e) => e.dataTransfer?.setData(MOVE, favorite.id)}
      ondragover={(e) => {
        if (!e.dataTransfer?.types.includes(MOVE)) return;
        e.preventDefault();
        over = favorite.id;
      }}
      ondragleave={() => (over = null)}
      ondragend={() => (over = null)}
      ondrop={(e) => {
        over = null;
        const id = e.dataTransfer?.getData(MOVE);
        if (!id) return;
        e.stopPropagation();
        api.dispatch({ type: "moveEssential", favoriteId: id, index });
      }}
      onclick={(e) => e.button === 0 && open(favorite)}
      onkeydown={(e) => (e.key === "Enter" || e.key === " ") && open(favorite)}
      oncontextmenu={(e) =>
        openMenu(e, [
          ...(tabOf(favorite) && !tabOf(favorite)?.unloaded ? [{ label: t("chrome-ui-unload"), dispatch: () => api.dispatch({ type: "unloadEssential", windowId: win.id, favoriteId: favorite.id }) }] : []),
          { label: t("chrome-ui-remove"), dispatch: () => api.dispatch({ type: "removeEssential", favoriteId: favorite.id }) },
        ])}
    >
      <SiteIcon favicon={tabOf(favorite)?.favicon ?? favorite.favicon} title={favorite.title} size={18} />
    </div>
  {/each}
</div>

<style>
  .essentials { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; min-height: 8px; }
  .cell { display: grid; place-content: center; height: 44px; border-radius: 12px; background: color-mix(in srgb, var(--glass-hi) 60%, transparent); box-shadow: inset 0 0 0 1px var(--glass-edge); transition: transform var(--tap), background var(--tap), box-shadow var(--tap), opacity var(--tap); }
  /* Unloaded by the user: dimmed until opened again. */
  .cell.unloaded { opacity: 0.45; }
  .cell:hover { background: var(--glass-hi); }
  .cell:active { transform: scale(0.97); }
  /* Inside the box: the sidebar's scroll area clips what sticks out. */
  .cell.over { box-shadow: inset 0 0 0 1.5px var(--accent); transform: scale(1.06); }
  .cell.active { background: var(--glass-hi); box-shadow: inset 0 0 0 1.5px var(--accent); }
</style>
