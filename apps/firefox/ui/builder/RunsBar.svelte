<script lang="ts">
  import type { Executions } from "./executions.svelte";
  import { TRIGGERS, outputElements, hour, STATUSES, TINTS } from "./labels";

  /**
   * The bottom bar: the last 8 runs (choosing one updates the badges, the « Bloc » tab and the preview) and
   * « Rejouer depuis ce bloc ». A refusal shows as text under the bar.
   */
  let {
    runs: executions,
    selection,
    output: output,
    replayable: replayable,
  }: {
    runs: Executions;
    /** The block selected on the canvas. */
    selection: string | null;
    /** Id of the workflow's `sortie` block (its items are the run's). */
    output: string | undefined;
    /** The saved workflow is valid and nothing is being saved. */
    replayable: boolean;
  } = $props();

  const last = $derived(executions.list.slice(0, 8));
  const chosen = $derived(executions.chosen?.id ?? null);
  const elements = (n: number | null) => (n === null ? "" : `${n} élément${n > 1 ? "s" : ""}`);
</script>

<footer class="bar">
  <div class="line">
    <ul class="executions">
      {#each last as e (e.id)}
        <li>
          <button
            data-testid="execution-{e.id}"
            class:active={e.id === chosen}
            aria-pressed={e.id === chosen}
            title={e.attempt ? `Essai depuis « ${e.attempt.start} »` : undefined}
            onclick={() => void executions.choose(e.id).catch(() => {})}
          >
            <span class="pill {TINTS[e.status]}"></span>
            <span>{hour(e.start)}</span>
            <span class="muted">{TRIGGERS[e.trigger]}</span>
            <span>{STATUSES[e.status]}</span>
            {#if elements(outputElements(e, output))}<span class="muted">{elements(outputElements(e, output))}</span>{/if}
            {#if e.attempt}<span class="trial">essai</span>{/if}
          </button>
        </li>
      {:else}
        <li class="muted empty">Aucune exécution pour l'instant.</li>
      {/each}
    </ul>
    <button
      class="replay"
      data-testid="replay"
      disabled={selection === null || chosen === null || executions.busy || !replayable}
      title={selection === null ? "Sélectionne un bloc" : undefined}
      onclick={() => selection !== null && void executions.replay(selection).catch(() => {})}>Rejouer depuis ce bloc</button
    >
  </div>
  {#if executions.denial}<p class="refusal" data-testid="replay-refusal">{executions.denial}</p>{/if}
</footer>

<style>
  .bar { flex: none; border-top: 1px solid var(--border); background: var(--bg-bar); padding: 6px 12px; font-size: 12px; }
  .line { display: flex; align-items: center; gap: 12px; }
  .executions { flex: 1; min-width: 0; display: flex; gap: 6px; margin: 0; padding: 0; list-style: none; overflow-x: auto; }
  .executions button { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); white-space: nowrap; font-size: 12px; }
  .executions button.active { border-color: var(--accent); background: var(--bg-active); }
  .pill { width: 8px; height: 8px; border-radius: 50%; background: var(--stopped); flex: none; }
  .pill.ok { background: var(--running); }
  .pill.warn { background: var(--in-progress); }
  .pill.bad { background: var(--in-error); }
  .trial { padding: 0 5px; border-radius: 4px; background: var(--bg-hover); color: var(--text-muted); }
  .replay { flex: none; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-bar); color: var(--text); }
  .replay:disabled { opacity: 0.5; }
  .refusal { margin: 6px 0 0; color: var(--in-error); white-space: pre-wrap; word-break: break-word; }
  .muted { color: var(--text-muted); }
  .empty { padding: 4px 0; }
</style>
