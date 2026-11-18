<script lang="ts">
  import { fade } from "svelte/transition";
  import { VIM_KEYS } from "../../shared/vim-keys";
  import { bindingFromKey, bindingLabel, bindingProblem, effectiveBindings, sameBinding, SHORTCUT_IDS, SHORTCUTS, type ShortcutId } from "../../shared/shortcuts";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  const win = window.parent.ressacWindow!;
  const FIXED = [
    ["agent-shortcuts-fixed-tab", "⌘1–9"],
    ["agent-shortcuts-fixed-space", "⌃1–9"],
    ["agent-shortcuts-fixed-recent", "⌃Tab / ⌃⇧Tab"],
  ];
  /** The vim table's Escape key is written in French there. */
  const vimKey = (k: string) => k.replace(/\u00c9chap$/, t("agent-vim-key-escape"));
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
    const refused = bindingProblem(id, binding, effective);
    if (refused) problem = { id, text: refused.problem === "taken" ? t("sidebar-binding-taken", { action: t(SHORTCUTS[refused.by].label) }) : t(`sidebar-binding-${refused.problem}`) };
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

<section data-testid="settings-shortcuts" aria-label={t("settings-section-shortcuts")}>
  <div class="group">
    <SettingsRow label={t("agent-shortcuts-vim")} id="vim-mode" help={t("agent-shortcuts-vim-help")}>
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
    </SettingsRow>
  </div>
  {#if appState.value?.settings.vimMode}
    <div class="vim-keys" data-testid="vim-keys" out:fade={{ duration: 150 }}>
      {#each VIM_KEYS as group, gi (group.title)}
        <h3 class="group-title">{t(`agent-vim-${gi}-title`)}</h3>
        <div class="group">
          {#each group.rows as row, ri (row.keys.join())}
            <div class="row">
              <span class="keys">{#each row.keys as k (k)}<kbd>{vimKey(k)}</kbd>{/each}</span>
              <span class="grow">{t(`agent-vim-${gi}-${ri}`)}</span>
            </div>
          {/each}
        </div>
      {/each}
    </div>
  {/if}
  <div class="group-head">
    <h3 class="group-title">{t("settings-section-shortcuts")}</h3>
    <button data-testid="shortcuts-reset-all" disabled={!Object.keys(overrides).length} onclick={() => api.dispatch({ type: "resetShortcuts" })}>{t("agent-shortcuts-reset-all")}</button>
  </div>
  <div class="group">
    {#each SHORTCUT_IDS as id (id)}
      <div class="row" data-testid="shortcut-{id}">
        <div class="grow">
          <b>{t(SHORTCUTS[id].label)}</b>
          {#if problem?.id === id}<span class="alert" role="alert" transition:fade={{ duration: 150 }}>{problem.text}</span>{/if}
        </div>
        {#if capturing === id}
          <span class="muted" data-testid="shortcut-{id}-prompt">{t("agent-shortcuts-prompt")}</span>
        {:else}
          <kbd data-testid="shortcut-{id}-key">{bindingLabel(effective[id])}</kbd>
          {#if !sameBinding(effective[id], SHORTCUTS[id].default)}
            <button data-testid="shortcut-{id}-reset" onclick={() => api.dispatch({ type: "resetShortcut", id })}>{t("agent-shortcuts-reset")}</button>
          {/if}
          <button data-testid="shortcut-{id}-edit" onclick={() => start(id)}>{t("agent-shortcuts-edit")}</button>
        {/if}
      </div>
    {/each}
    {#each FIXED as [name, keys]}
      <div class="row">
        <b class="grow">{t(name)}</b>
        <kbd>{keys}</kbd>
      </div>
    {/each}
  </div>
</section>

<style>
  .vim-keys { animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .vim-keys .keys { display: flex; gap: 6px; width: 92px; flex: none; }
</style>
