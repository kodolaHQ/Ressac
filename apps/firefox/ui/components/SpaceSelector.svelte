<script lang="ts">
  import { DEFAULT_AURA } from "../../shared/aura";
  import AuraEmoji from "./AuraEmoji.svelte";
  import Icon from "./Icon.svelte";
  import type { Space, WindowState } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import { openMenu } from "./menu.svelte";
  import { t } from "../i18n.svelte";
  import { deletionLosses, losesConnections, PROFILE_TO_CHOOSE } from "./spaceProfiles";
  import { fade } from "svelte/transition";
  import { spaceSettings } from "./spaceSettings.svelte";
  import { showSection } from "./settings-section.svelte";

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
  /** Space to delete awaiting confirmation (it contains tabs or pinned sites, or it takes sign-ins with it). */
  let toDelete = $state<({ space: Space } & NonNullable<ReturnType<typeof deletionLosses>>) | null>(null);

  /** « Supprimer aussi son passeport »: unticked, the passport is kept (design § 4.4). */
  let dropPassport = $state(false);
  /** A drop that failed (nothing changed), or one done for a space the state then kept. */
  let failure = $state<"failed" | "space-kept" | null>(null);
  /** A drop pending: the confirmation takes no other press. */
  let deleting = $state(false);
  const tabsOf = (space: Space) => Object.values(appState.value?.tabs ?? {}).filter((o) => o.spaceId === space.id).length;

  async function remove(space: Space) {
    if (deleting) return;
    const spaces = appState.value?.spaces ?? [];
    // Counted (no decrypt) only for a profile that goes with the space; no answer: 0, the passport is kept.
    const passport = losesConnections(spaces, space) ? ((await api.settings.passport?.profiles().catch(() => null))?.find((p) => p.id === space.profile)?.count ?? 0) : 0;
    const lost = deletionLosses(appState.value?.spaces ?? [], space, tabsOf(space), passport);
    dropPassport = false;
    failure = null;
    if (lost) toDelete = { space, ...lost };
    else api.dispatch({ type: "deleteSpace", id: space.id });
  }

  /** The reducer's refusals (core/state/actions.ts deleteSpace): the last space, or one already gone. */
  const deletable = (id: string) => (appState.value?.spaces.length ?? 0) > 1 && !!appState.value?.spaces.some((e) => e.id === id);

  async function confirmDelete(space: Space, passport: number) {
    if (deleting) return;
    // Recomputed now: a profile another window has just started using keeps its passport.
    const now = deletionLosses(appState.value?.spaces ?? [], space, tabsOf(space), passport);
    if (now?.passport && dropPassport) {
      // The passport goes first: a failed drop keeps the space and says so, never a space gone with its passport said gone.
      deleting = true;
      const ok = await api.settings.passport!.drop(space.profile).finally(() => (deleting = false));
      if (toDelete?.space.id !== space.id) return;
      if (!ok) return void (failure = "failed");
      toDelete = { ...toDelete, passport: 0 };
      if (!appState.value?.spaces.some((e) => e.id === space.id)) return void (toDelete = null);
      if (!deletable(space.id)) return void (failure = "space-kept");
    }
    api.dispatch({ type: "deleteSpace", id: space.id });
    toDelete = null;
  }

  /** Réglages › Passeport on this space's profile. */
  function openPassport(space: Space) {
    showSection("passport", { profile: space.profile });
    api.dispatch({ type: "openSettings", windowId: win.id });
  }

  // A setting keeps the space's current profile (alone or shared); a new space has none: the user chooses.
  const set = (space: Space) =>
    (spaceSettings.draft = { id: space.id, name: space.name, icon: space.icon, private: space.private, profile: space.profile, aura: space.aura });
  function create() {
    spaceSettings.draft = { id: null, name: "", icon: "📁", private: false, profile: PROFILE_TO_CHOOSE, aura: DEFAULT_AURA };
  }
</script>

{#if toDelete}
  {@const { space: space, tabs: tabs, logins: connexions, pinned, folders, passport } = toDelete}
  <div class="confirmation" role="alertdialog" aria-label={t("sidebar-space-delete-title")}>
    <p>
      {#if tabs > 0}{t("sidebar-space-delete-tabs", { name: space.name, tabs })}{:else}{t("sidebar-space-delete", { name: space.name })}{/if}
      {#if pinned > 0 || folders > 0}{t("sidebar-space-delete-pinned", { pinned, folders })}{/if}
      {#if connexions}{t("sidebar-space-delete-logins")}{/if}
      {#if passport > 0}{t("sidebar-space-passport-count", { count: passport })}{/if}
    </p>
    {#if passport > 0}
      <label class="drop" out:fade={{ duration: 120 }}><input type="checkbox" data-testid="space-delete-passport" disabled={deleting} bind:checked={dropPassport} /> {t("sidebar-space-passport-drop")}</label>
    {/if}
    {#if failure}<p class="failed" role="alert" data-testid="space-delete-passport-failed" out:fade={{ duration: 120 }}>{t(failure === "failed" ? "sidebar-space-passport-drop-failed" : "sidebar-space-passport-dropped-only")}</p>{/if}
    <div class="buttons">
      <button disabled={deleting} onclick={() => (toDelete = null)}>{t("sidebar-cancel")}</button>
      <button class="danger" disabled={deleting} onclick={() => void confirmDelete(space, passport)}>{t("sidebar-delete")}</button>
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
      onkeydown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        api.dispatch({ type: "activateSpace", windowId: win.id, id: space.id });
      }}
      data-testid="space-{space.id}"
      aria-current={space.id === win.activeSpace ? "true" : undefined}
      title={space.private ? t("sidebar-space-private", { name: space.name }) : space.name}
      data-private={space.private || undefined}
      onclick={(e) => e.button === 0 && api.dispatch({ type: "activateSpace", windowId: win.id, id: space.id })}
      oncontextmenu={(e) =>
        openMenu(e, [
          { label: t("sidebar-space-settings"), dispatch: () => set(space) },
          // A profile of private spaces only has no passport of its own (design § 3.2).
          ...(space.private ? [] : [{ label: t("sidebar-space-passport"), dispatch: () => openPassport(space) }]),
          ...((appState.value?.spaces.length ?? 0) > 1 ? [{ label: t("sidebar-delete"), dispatch: () => void remove(space) }] : []),
        ])}
      ><AuraEmoji icon={space.icon} aura={space.aura} size={28} />{#if space.private}<span class="padlock" aria-hidden="true"><Icon name="lock" size={9} /></span>{/if}</div
    >
  {/each}
  <button data-testid="new-space" title={t("sidebar-space-new")} onclick={create}><Icon name="plus" /></button>
</nav>

<style>
  /* A single scrolling row; the padding keeps the grown aura glow and the padlock inside the scroll box. */
  .spaces { display: flex; gap: 2px; padding: 3px 2px; margin: -3px -2px; overflow-x: auto; scrollbar-width: none; }
  /* Round chips: the space's emoji over its own aura's glow, brighter and larger on the active one (AuraEmoji). */
  .spaces :is(button, .space) { all: unset; flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: var(--text-muted); position: relative; transition: transform var(--tap), background var(--tap); }
  .spaces :is(button, .space):hover { background: color-mix(in srgb, var(--glass-hi) 60%, transparent); color: var(--text); }
  .spaces :is(button, .space):active { transform: scale(0.97); }
  .spaces :is(button, .space)[aria-current="true"] { background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--border), var(--lift); color: var(--text); }
  /* Under a dragged space: the drop lands here. */
  /* Its icon and padlock never take the pointer: a drag over them stays a drag over the chip, no highlight flicker. */
  .spaces .space > :global(*) { pointer-events: none; }
  .spaces .space.over { box-shadow: inset 0 0 0 1.5px var(--accent); transform: scale(1.06); }
  .padlock { position: absolute; left: -2px; bottom: -3px; padding: 2px; border-radius: 999px; background: var(--glass-dense); color: var(--text); box-shadow: 0 0 0 1px var(--glass-edge); }
  .confirmation { flex: 1 0 100%; box-sizing: border-box; padding: 10px; border-radius: 12px; background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--glass-edge); color: var(--text); -webkit-app-region: no-drag; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .confirmation p { margin: 0 0 8px; }
  .drop { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; }
  .confirmation .failed { font-weight: 600; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .buttons { display: flex; justify-content: flex-end; gap: 6px; }
  .buttons button { padding: 5px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--sheet); color: var(--text); font: inherit; transition: transform var(--tap); }
  .buttons button:active:not(:disabled) { transform: scale(0.97); }
  .buttons button:disabled { opacity: 0.5; }
  .buttons .danger { background: var(--in-error); border-color: var(--in-error); color: var(--accent-ink); }
</style>
