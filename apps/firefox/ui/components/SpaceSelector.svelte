<script lang="ts">
  import { DEFAULT_AURA } from "../../shared/aura";
  import AuraEmoji from "./AuraEmoji.svelte";
  import Icon from "./Icon.svelte";
  import type { Space, WindowState } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import { openMenu } from "./menu.svelte";
  import { t } from "../i18n.svelte";
  import { losesConnections, PROFILE_TO_CHOOSE } from "./spaceProfiles";
  import { spaceSettings } from "./spaceSettings.svelte";

  let { window: win }: { window: WindowState } = $props();
  const MOVE = "application/x-ressac-space";
  /** The space under a dragged one: it shows where the drop lands. */
  let over = $state<string | null>(null);
  let nav: HTMLElement;
  // The row scrolls when full: keep the active space in view (⌃1…, ⌃Tab, another window's switch).
  // A primitive: `win` is a new object at each broadcast, the row would jump back under a scrolling user.
  const activeSpace = $derived(win.activeSpace);
  $effect(() => {
    void activeSpace;
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
  <div class="confirmation" role="alertdialog" aria-label={t("sidebar-space-delete-title")}>
    <p>
      {#if tabs > 0}{t("sidebar-space-delete-tabs", { name: space.name, tabs })}{:else}{t("sidebar-space-delete", { name: space.name })}{/if}
      {#if connexions}{t("sidebar-space-delete-logins")}{/if}
    </p>
    <div class="buttons">
      <button onclick={() => (toDelete = null)}>{t("sidebar-cancel")}</button>
      <button
        class="danger"
        onclick={() => {
          api.dispatch({ type: "deleteSpace", id: space.id });
          toDelete = null;
        }}>{t("sidebar-delete")}</button
      >
    </div>
  </div>
{/if}
<nav class="spaces" bind:this={nav}>
  {#each appState.value?.spaces ?? [] as space, index (space.id)}
    <!-- A div, not a button: Firefox does not start a drag from a button. -->
    <div
      role="button"
      tabindex="0"
      class="space"
      class:over={space.id === over}
      draggable="true"
      ondragstart={(e) => e.dataTransfer?.setData(MOVE, space.id)}
      ondragover={(e) => {
        if (!e.dataTransfer?.types.includes(MOVE)) return;
        e.preventDefault();
        over = space.id;
      }}
      ondragleave={() => (over = null)}
      ondragend={() => (over = null)}
      ondrop={(e) => {
        over = null;
        const id = e.dataTransfer?.getData(MOVE);
        if (!id) return;
        e.preventDefault();
        api.dispatch({ type: "moveSpace", id, index });
      }}
      onkeydown={(e) => (e.key === "Enter" || e.key === " ") && api.dispatch({ type: "activateSpace", windowId: win.id, id: space.id })}
      data-testid="space-{space.id}"
      aria-current={space.id === win.activeSpace ? "true" : undefined}
      title={space.private ? t("sidebar-space-private", { name: space.name }) : space.name}
      data-private={space.private || undefined}
      onclick={(e) => e.button === 0 && api.dispatch({ type: "activateSpace", windowId: win.id, id: space.id })}
      oncontextmenu={(e) =>
        openMenu(e, [
          { label: t("sidebar-space-settings"), dispatch: () => set(space) },
          ...((appState.value?.spaces.length ?? 0) > 1 ? [{ label: t("sidebar-delete"), dispatch: () => remove(space) }] : []),
        ])}
      ><AuraEmoji icon={space.icon} aura={space.aura} size={28} />{#if space.private}<span class="padlock" aria-hidden="true"><Icon name="lock" size={9} /></span>{/if}</div
    >
  {/each}
  <button data-testid="new-space" title={t("sidebar-space-new")} onclick={create}><Icon name="plus" /></button>
</nav>

<style>
  /* A single scrolling row; the padding keeps the grown aura glow and the padlock inside the scroll box. */
  .spaces { display: flex; gap: 2px; padding: 3px 2px; margin: -3px -2px; overflow-x: auto; scrollbar-width: none; }
  .spaces:has(.confirmation) { flex-wrap: wrap; overflow: visible; }
  /* Round chips: the space's emoji over its own aura's glow, brighter and larger on the active one (AuraEmoji). */
  .spaces :is(button, .space) { all: unset; flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: var(--text-muted); position: relative; transition: transform var(--tap), background var(--tap); }
  .spaces :is(button, .space):hover { background: color-mix(in srgb, var(--glass-hi) 60%, transparent); color: var(--text); }
  .spaces :is(button, .space):active { transform: scale(0.97); }
  .spaces :is(button, .space)[aria-current="true"] { background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--border), var(--lift); color: var(--text); }
  /* Under a dragged space: the drop lands here. */
  .spaces .space.over { box-shadow: inset 0 0 0 1.5px var(--accent); transform: scale(1.06); }
  .padlock { position: absolute; left: -2px; bottom: -3px; padding: 2px; border-radius: 999px; background: var(--glass-dense); color: var(--text); box-shadow: 0 0 0 1px var(--glass-edge); }
  .confirmation { flex: 1 0 100%; box-sizing: border-box; padding: 10px; border-radius: 12px; background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--glass-edge); color: var(--text); -webkit-app-region: no-drag; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .confirmation p { margin: 0 0 8px; }
  .buttons { display: flex; justify-content: flex-end; gap: 6px; }
  .buttons button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--sheet); color: var(--text); font: inherit; transition: transform var(--tap); }
  .buttons button:active { transform: scale(0.97); }
  .buttons .danger { background: var(--in-error); border-color: var(--in-error); color: var(--accent-ink); }
</style>
