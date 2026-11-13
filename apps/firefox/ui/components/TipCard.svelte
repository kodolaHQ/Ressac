<script lang="ts">
  import { fade } from "svelte/transition";
  import { nextTip } from "../../shared/hints";
  import { shortcutLabel } from "../../shared/shortcuts";
  import { appState } from "../state.svelte";
  import { openCommand } from "./command.svelte";
  import { agentNoteShowing, markSeen } from "./hints";

  const hints = $derived(appState.value?.settings.hints);
  // Not under the first-launch welcome.
  // And not beside the agent note, which shows in the open panel: one hint at a time.
  const tip = $derived(hints?.enabled && appState.value?.settings.onboarded !== false && !agentNoteShowing() ? nextTip(hints.seen) : null);

  const key = $derived(tip?.shortcut ? shortcutLabel(tip.shortcut, appState.value?.settings) : tip?.keys);

  function tryIt() {
    if (!tip) return;
    // Read before marking: the state may move on to the next tip at once.
    const { id, tryIt } = tip;
    markSeen(id);
    if (tryIt === "command") openCommand("new");
    else window.parent.ressacWindow!.openAgent();
  }
</script>

{#if tip}
  <aside class="tip" data-testid="tip-card" out:fade={{ duration: 150 }}>
    <b>Astuce</b>
    <p>{tip.text.replace("{key}", key ?? "")}</p>
    <div class="row">
      {#if key}<kbd>{key}</kbd>{/if}
      <span class="grow"></span>
      {#if tip.tryIt}<button type="button" class="primary" data-testid="tip-try" onclick={tryIt}>Essayer</button>{/if}
      <button type="button" data-testid="tip-next" onclick={() => markSeen(tip.id)}>Une autre</button>
      <button type="button" class="close" data-testid="tip-close" aria-label="Fermer l'astuce" onclick={() => markSeen(tip.id)}>×</button>
    </div>
  </aside>
{/if}

<style>
  .tip { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-radius: 16px; border: 1px solid var(--glass-edge); background: var(--glass); box-shadow: var(--float); color: var(--text); flex-shrink: 0; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  b { font-size: 12px; color: var(--text-muted); }
  p { margin: 0; font-size: 14px; line-height: 1.45; }
  .row { display: flex; align-items: center; gap: 8px; }
  .grow { flex: 1; }
  kbd { font: 600 12px var(--font-mono); color: var(--text-muted); }
  button { padding: 6px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 13px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  button:hover { background: var(--bg-active); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button.close { padding-inline: 9px; border-color: transparent; background: none; color: var(--text-muted); }
  button.close:hover { background: var(--bg-hover); color: var(--text); }
</style>
