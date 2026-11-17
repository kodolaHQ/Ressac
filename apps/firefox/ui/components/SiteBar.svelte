<script lang="ts">
  import { fade } from "svelte/transition";
  import type { ShownSite } from "../../shared/sites";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import SiteIcon from "./SiteIcon.svelte";
  import { openMenu } from "./menu.svelte";
  import { toEssentials } from "./site-placement";

  /** The site apps placed in the sidebar bar: one icon each, a click opens (or shows) the app's window. */
  let sites = $state<ShownSite[]>([]);
  let request = 0;
  async function load() {
    const n = ++request;
    const r = await api.sites.list();
    if (n === request) sites = r;
  }
  $effect(() => {
    void load();
    return api.sites.onChange(() => void load());
  });
  // In the bar's order; an id the host does not know (folder gone) is hidden.
  const shown = $derived((appState.value?.siteBar ?? []).flatMap((id) => sites.filter((s) => s.id === id)));

</script>

{#if shown.length}
  <div class="site-bar" role="group" aria-label={t("sidebar-site-bar")} out:fade={{ duration: 150 }}>
    {#each shown as s (s.id)}
      <button
        class="site"
        data-testid="site-bar-{s.id}"
        data-open={s.open || undefined}
        title={s.name}
        aria-label={s.name}
        onclick={() => api.sites.act(s.id, "open")}
        oncontextmenu={(e) =>
          openMenu(e, [
            { label: t("sidebar-site-to-essentials"), disabled: !s.start, dispatch: () => toEssentials(s) },
            { label: t("sidebar-site-remove-bar"), dispatch: () => api.dispatch({ type: "placeSite", id: s.id, placement: "none" }) },
          ])}
        out:fade={{ duration: 150 }}><SiteIcon favicon={s.icon} title={s.name} size={16} /></button
      >
    {/each}
  </div>
{/if}

<style>
  /* First line of the sidebar's footer, above the spaces, a hairline between: enter spring, exit fade (DESIGN.md). */
  .site-bar { flex: 1 0 100%; display: flex; flex-wrap: wrap; gap: 4px; margin: -2px -6px 2px; padding: 0 6px 8px; border-bottom: 1px solid var(--border); -moz-window-dragging: no-drag; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  /* Glass tiles the size of the space chips, so the site's own icon stands out on any aura. */
  .site { all: unset; position: relative; width: 28px; height: 28px; display: grid; place-content: center; border-radius: 9px; background: color-mix(in srgb, var(--glass-hi) 70%, transparent); box-shadow: inset 0 0 0 1px var(--glass-edge); transition: transform var(--tap), background var(--tap), box-shadow var(--tap); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .site:hover { background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--border), var(--lift); }
  .site:active { transform: scale(0.97); }
  .site:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  /* Its window is open: an accent dot under the tile. */
  .site[data-open]::after { content: ""; position: absolute; bottom: -5px; left: 50%; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: var(--accent); }
  @media (prefers-reduced-motion: reduce) { .site-bar, .site { animation: none; } }
</style>
