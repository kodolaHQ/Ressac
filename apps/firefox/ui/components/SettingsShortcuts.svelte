<script lang="ts">
  import { fade } from "svelte/transition";
  import { VIM_KEYS } from "../../shared/vim-keys";
  import { bindingFromKey, bindingLabel, bindingProblem, effectiveBindings, sameBinding, SHORTCUT_IDS, SHORTCUTS, type ShortcutId } from "../../shared/shortcuts";
  import { api, appState } from "../state.svelte";

  const win = window.parent.ressacWindow!;
  const FIXED = [
    ["Onglet 1 à 9", "⌘1–9"],
    ["Espace 1 à 9", "⌃1–9"],
    ["Onglets récents", "⌃Tab / ⌃⇧Tab"],
  ];
  const MODIFIER_KEYS = ["meta", "shift", "alt", "control", "capslock", "fn", "os"];

  const overrides = $derived(appState.value?.settings.shortcuts ?? {});
  const effective = $derived(effectiveBindings(overrides));
  let capturing = $state<ShortcutId | null>(null);
  let problem = $state<{ id: ShortcutId; text: string } | null>(null);

  // While a combination is awaited, the window's own shortcuts do nothing.
  $effect(() => {
    if (!capturing) return;
    win.setCapturingShortcut(true);
    return () => win.setCapturingShortcut(false);
  });

  function capture(e: KeyboardEvent) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    const key = e.key.toLowerCase();
    if (MODIFIER_KEYS.includes(key)) return;
    const id = capturing;
    if (key === "escape") return void (capturing = null);
    const binding = bindingFromKey(e);
    const text = bindingProblem(id, binding, effective);
    if (text) problem = { id, text };
    else api.dispatch(sameBinding(binding, SHORTCUTS[id].default) ? { type: "resetShortcut", id } : { type: "setShortcut", id, binding });
    capturing = null;
  }
  $effect(() => {
    if (!capturing) return;
    // Focus gone to another frame (the agent panel, a page): its keys never reach `capture`, so the capture ends.
    const stop = () => (capturing = null);
    window.addEventListener("keydown", capture, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("blur", stop);
    };
  });
  const start = (id: ShortcutId) => {
    problem = null;
    capturing = id;
  };
</script>

<section data-testid="settings-shortcuts">
  <h2>Raccourcis</h2>
  <div class="panel">
    <div class="row">
      <div class="grow">
        <label for="vim-mode"><b>Mode vim</b></label>
        <span class="muted" id="vim-mode-help">Des touches à la vim pour se déplacer dans les pages web.</span>
      </div>
      <input
        id="vim-mode"
        class="switch"
        type="checkbox"
        role="switch"
        data-testid="vim-mode"
        aria-describedby="vim-mode-help"
        checked={appState.value?.settings.vimMode ?? false}
        onchange={(e) => api.dispatch({ type: "setVimMode", enabled: e.currentTarget.checked })}
      />
    </div>
  </div>
  {#if appState.value?.settings.vimMode}
    <div class="vim-keys" data-testid="vim-keys" out:fade={{ duration: 150 }}>
      {#each VIM_KEYS as group (group.title)}
        <h3>{group.title}</h3>
        <div class="panel">
          {#each group.rows as row (row.keys.join())}
            <div class="row">
              <span class="keys">{#each row.keys as k (k)}<kbd>{k}</kbd>{/each}</span>
              <span class="grow">{row.action}</span>
            </div>
          {/each}
        </div>
      {/each}
    </div>
  {/if}
  <div class="panel list">
    {#each SHORTCUT_IDS as id (id)}
      <div class="row" data-testid="shortcut-{id}">
        <div class="grow">
          <b>{SHORTCUTS[id].label}</b>
          {#if problem?.id === id}<span class="alert" role="alert" transition:fade={{ duration: 150 }}>{problem.text}</span>{/if}
        </div>
        {#if capturing === id}
          <span class="muted" data-testid="shortcut-{id}-prompt">Appuyez sur la nouvelle combinaison…</span>
        {:else}
          <kbd data-testid="shortcut-{id}-key">{bindingLabel(effective[id])}</kbd>
          {#if !sameBinding(effective[id], SHORTCUTS[id].default)}
            <button data-testid="shortcut-{id}-reset" onclick={() => api.dispatch({ type: "resetShortcut", id })}>Rétablir</button>
          {/if}
          <button data-testid="shortcut-{id}-edit" onclick={() => start(id)}>Modifier</button>
        {/if}
      </div>
    {/each}
    {#each FIXED as [name, keys]}
      <div class="row">
        <b class="grow">{name}</b>
        <kbd>{keys}</kbd>
      </div>
    {/each}
  </div>
  <div class="buttons start"><button data-testid="shortcuts-reset-all" disabled={!Object.keys(overrides).length} onclick={() => api.dispatch({ type: "resetShortcuts" })}>Tout rétablir</button></div>
</section>

<style>
  .list { margin-top: 14px; }
  .switch { appearance: none; position: relative; width: 34px; height: 20px; margin: 0; flex: none; border-radius: 10px; background: var(--bg-active); transition: background var(--tap); }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--on-color); box-shadow: var(--float); transition: left var(--spring-d) var(--spring); }
  .switch:checked { background: var(--accent); }
  .switch:checked::after { left: 16px; }
  kbd { font: 12px var(--font-mono); color: var(--text-muted); }
  .vim-keys { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .vim-keys .keys { display: flex; gap: 8px; width: 84px; flex: none; }
  .vim-keys kbd { color: var(--accent); }
</style>
