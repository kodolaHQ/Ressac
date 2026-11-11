<script lang="ts">
  import { DEFAULT_AURA } from "../../shared/aura";
  import AuraDot from "./AuraDot.svelte";
  import Icon from "./Icon.svelte";
  import type { Space, WindowState } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import { openMenu } from "./menu.svelte";
  import { losesConnections, PROFILE_TO_CHOOSE } from "./spaceProfiles";
  import { spaceSettings } from "./spaceSettings.svelte";

  let { window: win }: { window: WindowState } = $props();
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
<nav class="spaces">
  {#each appState.value?.spaces ?? [] as space (space.id)}
    <button
      data-testid="space-{space.id}"
      aria-current={space.id === win.activeSpace ? "true" : undefined}
      title={space.private ? `${space.name} (privé)` : space.name}
      data-private={space.private || undefined}
      onclick={() => api.dispatch({ type: "activateSpace", windowId: win.id, id: space.id })}
      oncontextmenu={(e) =>
        openMenu(e, [
          { label: "Réglages", dispatch: () => set(space) },
          ...((appState.value?.spaces.length ?? 0) > 1 ? [{ label: "Supprimer", dispatch: () => remove(space) }] : []),
        ])}
      >{space.icon}<span class="aura"><AuraDot aura={space.aura} size={8} /></span>{#if space.private}<span class="padlock" aria-hidden="true">🔒</span>{/if}</button
    >
  {/each}
  <button data-testid="new-space" title="Nouvel espace" onclick={create}><Icon name="plus" /></button>
</nav>

<style>
  .spaces { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 0; }
  .spaces button { all: unset; width: 28px; height: 28px; display: grid; place-content: center; border-radius: 6px; color: var(--text-muted); position: relative; }
  .spaces button:hover { background: var(--bg-hover); }
  .spaces button[aria-current="true"] { background: var(--bg-active); }
  .aura { position: absolute; left: 2px; bottom: 2px; line-height: 0; }
  .padlock { position: absolute; right: -3px; bottom: -3px; font-size: 9px; line-height: 1; }
  .confirmation { padding: 8px; border-radius: 6px; background: var(--bg-active); color: var(--text); -webkit-app-region: no-drag; }
  .confirmation p { margin: 0 0 8px; }
  .buttons { display: flex; justify-content: flex-end; gap: 6px; }
  .buttons button { padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
  .buttons .danger { background: #c0392b; border-color: #c0392b; color: white; }
</style>
