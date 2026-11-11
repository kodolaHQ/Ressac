<script lang="ts">
  import { DEFAULT_AURA } from "../../shared/aura";
  import AuraEmoji from "./AuraEmoji.svelte";
  import Icon from "./Icon.svelte";
  import type { Space, WindowState } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import { openMenu } from "./menu.svelte";
  import { losesConnections, PROFILE_TO_CHOOSE } from "./spaceProfiles";
  import { spaceSettings } from "./spaceSettings.svelte";

  let { window: win }: { window: WindowState } = $props();
  let nav: HTMLElement;
  // The row scrolls when full: keep the active space in view (⌃1…, ⌃Tab, another window's switch).
  $effect(() => {
    void win.activeSpace;
    nav.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  /** Space to delete awaiting confirmation (it contains tabs, or it takes sign-ins with it). */
  let toDelete = $state<{ space: Space; tabs: number; logins: boolean } | null>(null);

  function remove(space: Space) {
    const n = Object.values(appState.value?.tabs ?? {}).filter((o) => o.spaceId === space.id).length;
    const logins = losesConnections(appState.value?.spaces ?? [], space);
    if (n > 0 || logins) toDelete = { space: space, tabs: n, logins };
    else api.dispatch({ type: "deleteSpace", id: space.id });
  }

  // A setting keeps the space's current profile (alone or shared); a new space has none: the user chooses.
  const set = (space: Space) =>
    (spaceSettings.draft = { id: space.id, name: space.name, icon: space.icon, private: space.private, profile: space.profile, aura: space.aura });
  function create() {
    spaceSettings.draft = { id: null, name: "", icon: "📁", private: false, profile: PROFILE_TO_CHOOSE, aura: DEFAULT_AURA };
  }
</script>

{#if toDelete}
  {@const { space: space, tabs: tabs, logins: connexions } = toDelete}
  <div class="confirmation" role="alertdialog" aria-label="Supprimer l'espace">
    <p>
      {#if tabs > 0}Supprimer l'espace « {space.name} » et ses {tabs} onglet{tabs > 1 ? "s" : ""} ?{:else}Supprimer l'espace « {space.name} » ?{/if}
      {#if connexions}Les connexions de cet espace seront perdues.{/if}
    </p>
    <div class="buttons">
      <button onclick={() => (toDelete = null)}>Annuler</button>
      <button
        class="danger"
        onclick={() => {
          api.dispatch({ type: "deleteSpace", id: space.id });
          toDelete = null;
        }}>Supprimer</button
      >
    </div>
  </div>
{/if}
<nav class="spaces" bind:this={nav}>
  {#each appState.value?.spaces ?? [] as space (space.id)}
    <button
      data-testid="space-{space.id}"
      aria-current={space.id === win.activeSpace ? "true" : undefined}
      title={space.private ? `${space.name} (privé)` : space.name}
      data-private={space.private || undefined}
      onclick={(e) => e.button === 0 && api.dispatch({ type: "activateSpace", windowId: win.id, id: space.id })}
      oncontextmenu={(e) =>
        openMenu(e, [
          { label: "Réglages", dispatch: () => set(space) },
          ...((appState.value?.spaces.length ?? 0) > 1 ? [{ label: "Supprimer", dispatch: () => remove(space) }] : []),
        ])}
      ><AuraEmoji icon={space.icon} aura={space.aura} />{#if space.private}<span class="padlock" aria-hidden="true">🔒</span>{/if}</button
    >
  {/each}
  <button data-testid="new-space" title="Nouvel espace" onclick={create}><Icon name="plus" /></button>
</nav>

<style>
  /* A single scrolling row; the padding keeps the grown aura glow and the padlock inside the scroll box. */
  .spaces { display: flex; gap: 2px; padding: 3px 2px; margin: -3px -2px; overflow-x: auto; scrollbar-width: none; }
  .spaces:has(.confirmation) { flex-wrap: wrap; overflow: visible; }
  /* Round chips: the space's emoji over its own aura's glow, brighter and larger on the active one (AuraEmoji). */
  .spaces button { all: unset; flex: none; width: 28px; height: 28px; display: grid; place-content: center; border-radius: 50%; color: var(--text-muted); position: relative; transition: transform var(--tap), background var(--tap); }
  .spaces button:hover { background: color-mix(in srgb, var(--glass-hi) 60%, transparent); color: var(--text); }
  .spaces button:active { transform: scale(0.97); }
  .spaces button[aria-current="true"] { background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--border), var(--lift); color: var(--text); }
  .padlock { position: absolute; left: -2px; bottom: -3px; font-size: 9px; line-height: 1; }
  .confirmation { flex: 1 0 100%; box-sizing: border-box; padding: 10px; border-radius: 12px; background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--glass-edge); color: var(--text); -webkit-app-region: no-drag; animation: webaios-rise var(--spring-d) var(--spring) backwards; }
  .confirmation p { margin: 0 0 8px; }
  .buttons { display: flex; justify-content: flex-end; gap: 6px; }
  .buttons button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--sheet); color: var(--text); font: inherit; transition: transform var(--tap); }
  .buttons button:active { transform: scale(0.97); }
  .buttons .danger { background: var(--in-error); border-color: var(--in-error); color: var(--accent-ink); }
</style>
