<script lang="ts">
  import type { Executions } from "./executions.svelte";
  import { t } from "../i18n.svelte";
  import { trigger, outputElements, hour, status, TINTS } from "./labels";

  /**
   * The bottom bar: the last 8 runs (choosing one updates the badges, the « Bloc » tab and the preview) and
   * « Rejouer depuis ce bloc ». A refusal shows as text under the bar.
   */
  let {
    runs: executions,
    selection,
    output,
    replayable,
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
  const elements = (n: number | null) => (n === null ? "" : t("builder-elements", { count: n }));
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
            title={e.attempt ? t("builder-attempt-since", { start: e.attempt.start }) : undefined}
            onclick={() => void executions.choose(e.id).catch(() => {})}
          >
            <span class="pill {TINTS[e.status]}"></span>
            <span>{hour(e.start)}</span>
            <span class="muted">{trigger(e.trigger)}</span>
            <span>{status(e.status)}</span>
            {#if elements(outputElements(e, output))}<span class="muted">{elements(outputElements(e, output))}</span>{/if}
            {#if e.attempt}<span class="trial">{t("builder-attempt-tag")}</span>{/if}
          </button>
        </li>
      {:else}
        <li class="muted empty">{t("builder-no-run")}</li>
      {/each}
    </ul>
    <button
      class="replay"
      data-testid="replay"
      disabled={selection === null || chosen === null || executions.busy || !replayable}
      title={selection === null ? t("builder-replay-select") : undefined}
      onclick={() => selection !== null && void executions.replay(selection).catch(() => {})}>{t("builder-replay")}</button
    >
  </div>
  {#if executions.denial}<p class="refusal" data-testid="replay-refusal">{executions.denial}</p>{/if}
</footer>

<style>
  .bar { flex: none; border-top: 1px solid var(--border); padding: 7px 12px; font-size: 12px; }
  .line { display: flex; align-items: center; gap: 12px; }
  .executions { flex: 1; min-width: 0; display: flex; gap: 6px; margin: 0; padding: 0; list-style: none; overflow-x: auto; }
  .executions button { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); white-space: nowrap; font-size: 12px; transition: transform var(--tap); }
  .executions button:active { transform: scale(0.97); }
  .executions button.active { border-color: var(--accent); box-shadow: var(--lift); }
  .pill { width: 8px; height: 8px; border-radius: 50%; background: var(--stopped); flex: none; }
  .pill.ok { background: var(--running); }
  .pill.warn { background: var(--in-progress); }
  .pill.bad { background: var(--in-error); }
  .trial { padding: 0 6px; border-radius: 6px; background: var(--bg-hover); color: var(--text-muted); }
  .replay { flex: none; padding: 5px 11px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12px var(--font-ui); transition: transform var(--tap); }
  .replay:active:not(:disabled) { transform: scale(0.97); }
  .replay:disabled { opacity: 0.5; }
  .refusal { margin: 6px 0 0; color: var(--in-error); white-space: pre-wrap; word-break: break-word; }
  .muted { color: var(--text-muted); }
  .empty { padding: 4px 0; }
</style>
