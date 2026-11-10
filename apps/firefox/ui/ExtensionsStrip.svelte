<script lang="ts">
  import type { WindowState } from "../shared/model";
  import { api } from "./state.svelte";
  import type { AddonButton, PendingUpdate } from "../chrome/window/addons";

  // The add-on buttons of the active window (chrome/window/addons.ts), copied into this document like ui/api.ts does.
  // `window` only opens the agent's Extensions page: the window announces changes itself (onChange, every tab switch).
  let { window: win }: { window: WindowState } = $props();
  const addons = window.parent.webaiosWindow!.addons;
  let buttons = $state<AddonButton[]>(structuredClone(addons.buttons()));
  let updates = $state<PendingUpdate[]>(structuredClone(addons.updates()));
  let open = $state(false);

  $effect(() => {
    const off = addons.onChange(() => {
      buttons = structuredClone(addons.buttons());
      updates = structuredClone(addons.updates());
    });
    window.addEventListener("unload", off, { once: true });
    return off;
  });

  const pinned = $derived(buttons.filter((b) => b.pinned));
  const unpinned = $derived(buttons.filter((b) => !b.pinned));
  const act = (f: () => void) => () => {
    open = false;
    f();
  };
</script>

{#snippet button(b: AddonButton)}
  <button
    class="action"
    class:no-icon={!b.icon}
    style:background-image={b.icon ? `url("${b.icon}")` : null}
    data-letter={b.name.charAt(0)}
    data-testid="action-extension"
    data-id={b.id}
    title={b.title}
    aria-label={b.title}
    disabled={!b.enabled}
    onclick={(e) => {
      addons.click(b.id, structuredClone(e.currentTarget.getBoundingClientRect().toJSON()));
      open = false;
    }}
  >
    {#if b.badge}<span class="badge" style:background-color={b.badgeColor} style:color={b.badgeTextColor}>{b.badge}</span>{/if}
  </button>
{/snippet}

<div class="extensions" data-testid="extensions-bar">
  {#each pinned as b (b.id)}{@render button(b)}{/each}
  <button class="menu" data-testid="menu-extensions" aria-label="Extensions" title="Extensions" aria-expanded={open} onclick={() => (open = !open)}>
    ⧉{#if updates.length > 0}<span class="point"></span>{/if}
  </button>
</div>
{#if open}
  <!-- In the sidebar, never over the page. -->
  <div class="panel" data-testid="extensions-panel" role="region" aria-label="Extensions">
    {#if buttons.length === 0}<p class="empty">Aucune extension active.</p>{/if}
    <ul>
      {#each unpinned as b (b.id)}
        <li data-testid="extension-bar-row">
          {@render button(b)}
          <span class="name">{b.name}</span>
          <button class="link" onclick={() => addons.pin(b.id, true)}>Épingler</button>
        </li>
      {/each}
      {#each pinned as b (b.id)}
        <li data-testid="extension-bar-row">
          <span class="name">{b.name}</span>
          <button class="link" onclick={() => addons.pin(b.id, false)}>Détacher</button>
        </li>
      {/each}
      {#each updates as u (u.id)}
        <li data-testid="extension-update">
          <span class="name">{u.name} : mise à jour en attente de ton accord.</span>
          <button class="link" onclick={act(() => addons.reviewUpdate(u.id))}>Revoir la mise à jour</button>
        </li>
      {/each}
    </ul>
    <button class="manage" onclick={act(() => addons.manage())}>Gérer les extensions</button>
    <button class="manage" onclick={act(() => api.dispatch({ type: "openExtensions", windowId: win.id }))}>Extensions de l'agent</button>
    <button class="manage" onclick={act(() => addons.findMore())}>Trouver des modules</button>
  </div>
{/if}

<style>
  .extensions { display: flex; align-items: center; gap: 2px; flex: none; -webkit-app-region: no-drag; }
  .action { all: unset; position: relative; width: 24px; height: 24px; flex: none; border-radius: 5px; background-position: center; background-repeat: no-repeat; background-size: 16px; }
  .action:hover:not(:disabled), .menu:hover { background-color: var(--bg-hover); }
  .action:disabled { opacity: 0.4; }
  /* Without an icon: the first letter of the name. */
  .action.no-icon::after { content: attr(data-letter); position: absolute; inset: 4px; display: grid; place-content: center; border-radius: 4px; background: var(--bg-active); color: var(--text); font-size: 10px; text-transform: uppercase; }
  .badge { position: absolute; right: 0; bottom: 0; padding: 0 2px; border-radius: 2px; font-size: 9px; line-height: 12px; pointer-events: none; }
  .menu { all: unset; position: relative; width: 28px; height: 28px; display: grid; place-content: center; border-radius: 6px; color: var(--text-muted); font-size: 18px; }
  .point { position: absolute; right: 4px; top: 4px; width: 7px; height: 7px; border-radius: 50%; background: #e5484d; }
  /* min-width: 0: without it a long name (nowrap) would widen the panel, a flexible item of the row, out of the bar. */
  .panel { -webkit-app-region: no-drag; flex-basis: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; margin-top: 6px; padding: 4px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-active); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 6px; padding: 2px 4px; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
  .link, .manage { all: unset; padding: 2px 6px; border-radius: 5px; color: var(--text-muted); font-size: 12px; }
  .link { flex: none; white-space: nowrap; }
  .link:hover, .manage:hover { background: var(--bg-hover); color: var(--text); }
  .manage { display: block; margin-top: 2px; }
  .empty { margin: 4px; color: var(--text-muted); font-size: 12px; }
</style>
