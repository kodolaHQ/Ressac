<script lang="ts">
  import { fade } from "svelte/transition";
  import type { Favorite, Space, WindowState } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import Icon from "./Icon.svelte";
  import SiteIcon from "./SiteIcon.svelte";
  import SoundButton from "./SoundButton.svelte";
  import { openMenu, type MenuEntry } from "./menu.svelte";

  /** A space's pinned tabs: its folders first (one level, Arc/Zen model), then the pinned tabs outside any folder. */
  let { window: win, space, activeLink }: { window: WindowState; space: Space; activeLink: string | undefined } = $props();

  const TAB = "application/x-webaios-onglet";
  const loose = $derived(space.pinned.filter((f) => !space.folders.some((d) => d.id === f.folder)));
  let renaming = $state<string | null>(null);
  /** A folder was just asked for: its name is typed in place as soon as it exists. */
  let naming = false;
  let over = $state<string | null>(null);

  $effect(() => {
    const last = space.folders.at(-1);
    if (naming && last) [renaming, naming] = [last.id, false];
  });

  export function newFolder(favoriteId?: string) {
    naming = true;
    api.dispatch({ type: "createFolder", spaceId: space.id, name: "Nouveau dossier", favoriteId });
  }
  function rename(id: string, name: string) {
    renaming = null;
    if (name.trim()) api.dispatch({ type: "renameFolder", spaceId: space.id, id, name: name.trim() });
  }
  const favoriteMenu = (f: Favorite): MenuEntry[] => [
    { label: "Retirer", dispatch: () => api.dispatch({ type: "unpin", spaceId: space.id, favoriteId: f.id }) },
    ...space.folders.filter((d) => d.id !== f.folder).map((d) => ({ label: `Déplacer dans ${d.name}`, dispatch: () => api.dispatch({ type: "moveToFolder", spaceId: space.id, favoriteId: f.id, folderId: d.id }) })),
    ...(f.folder ? [{ label: "Sortir du dossier", dispatch: () => api.dispatch({ type: "moveToFolder", spaceId: space.id, favoriteId: f.id, folderId: null }) }] : []),
    { label: "Nouveau dossier", dispatch: () => newFolder(f.id) },
  ];
  function drop(e: DragEvent, folderId?: string) {
    e.stopPropagation();
    over = null;
    const id = e.dataTransfer?.getData(TAB);
    if (id) api.dispatch({ type: "pinTab", id, folderId });
  }
  /** The favorite's open tab in this window, if any: its sound pictogram sits on the row. */
  const tabOf = (f: Favorite) => Object.values(appState.value?.tabs ?? {}).find((t) => t.link?.id === f.id && t.windowId === win.id);
  const focus = (node: HTMLInputElement) => (node.focus(), node.select());
</script>

{#snippet row(f: Favorite)}
  <li out:fade={{ duration: 150 }}>
    <button
      data-testid="favorite-{f.id}"
      class:active={f.id === activeLink}
      onclick={(e) => e.button === 0 && api.dispatch({ type: "openFavorite", windowId: win.id, kind: "pinned", id: f.id })}
      oncontextmenu={(e) => openMenu(e, favoriteMenu(f))}
    >
      <SiteIcon favicon={f.favicon} title={f.title} />
      <span>{f.title}</span>
    </button>
    {#if tabOf(f)}<span class="sound"><SoundButton tab={tabOf(f)!} /></span>{/if}
  </li>
{/snippet}

<ul class="pinned" data-testid="pinned" ondragover={(e) => e.dataTransfer?.types.includes(TAB) && e.preventDefault()} ondrop={(e) => drop(e)}>
  {#each space.folders as d (d.id)}
    <li class="folder" data-testid="folder-{d.id}" out:fade={{ duration: 150 }}>
      {#if renaming === d.id}
        <!-- Enter or leaving the field keeps the name, Escape the old one. -->
        <input
          data-testid="folder-name"
          aria-label="Nom du dossier"
          value={d.name}
          use:focus
          onblur={(e) => renaming === d.id && rename(d.id, e.currentTarget.value)}
          onkeydown={(e) => (e.key === "Enter" ? rename(d.id, e.currentTarget.value) : e.key === "Escape" && (renaming = null))}
        />
      {:else}
        <button
          class="head"
          class:over={over === d.id}
          aria-expanded={!d.collapsed}
          onclick={(e) => e.button === 0 && api.dispatch({ type: "toggleFolder", spaceId: space.id, id: d.id })}
          oncontextmenu={(e) =>
            openMenu(e, [
              { label: "Renommer", dispatch: () => (renaming = d.id) },
              { label: "Supprimer le dossier", dispatch: () => api.dispatch({ type: "deleteFolder", spaceId: space.id, id: d.id }) },
            ])}
          ondragover={(e) => e.dataTransfer?.types.includes(TAB) && (e.preventDefault(), (over = d.id))}
          ondragleave={() => (over = null)}
          ondrop={(e) => drop(e, d.id)}
        >
          <span class="chevron" class:open={!d.collapsed}><Icon name="chevron" size={12} /></span>
          <Icon name="folder" size={16} />
          <span>{d.name}</span>
        </button>
      {/if}
      {#if !d.collapsed}
        <ul class="inside">
          {#each space.pinned.filter((f) => f.folder === d.id) as f (f.id)}{@render row(f)}{/each}
        </ul>
      {/if}
    </li>
  {/each}
  {#each loose as f (f.id)}{@render row(f)}{/each}
</ul>

<style>
  .pinned, .inside { list-style: none; margin: 0; padding: 0; }
  .pinned { min-height: 8px; }
  .inside { padding-left: 14px; }
  li { position: relative; animation: webaios-rise var(--spring-d) var(--spring) backwards; }
  .sound { position: absolute; right: 8px; top: 8px; }
  button { all: unset; display: flex; align-items: center; gap: 10px; width: calc(100% - 20px); height: 36px; padding: 0 10px; border-radius: 10px; color: var(--text); transition: transform var(--tap), background var(--tap); }
  button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button:hover { background: color-mix(in srgb, var(--glass-hi) 55%, transparent); }
  button.active, .head.over { background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--glass-edge); }
  button:active { transform: scale(0.97); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .head { gap: 8px; color: var(--text-muted); font-weight: 600; }
  .chevron { display: inline-flex; flex: none; transition: transform var(--tap); }
  .chevron.open { transform: rotate(90deg); }
  input { box-sizing: border-box; width: 100%; height: 36px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 13px var(--font-ui); }
</style>
