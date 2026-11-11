<script lang="ts">
  import type { Execution, ResumeExecution } from "@webaios/kernel";

  /**
   * What the block produced at the chosen run: status, duration, items, error, log and collapsible output. Everything
   * comes from a page or the agent's code: shown as text, never as HTML.
   */
  let {
    block: block,
    chosen: chosen,
    run: execution,
    notFound: notFound,
  }: { block: string; chosen: ResumeExecution | null; run: Execution | null; notFound: boolean } = $props();

  const LABELS: Record<string, string> = {
    succeeded: "réussi",
    partial: "partiel",
    failed: "échoué",
    interrupted: "interrompu",
    "not-run": "pas lancé",
    resumed: "repris",
  };

  const trace = $derived(execution?.id === chosen?.id ? execution?.blocks.find((b) => b.id === block) : undefined);
  /**
   * The output is only formatted once the fold is open (it can weigh 256 KB): the open fold, per run and per block.
   * Another run recreates a closed fold, without JSON; the same run re-read (finished meanwhile) keeps it.
   */
  const key = $derived(trace && execution ? `${execution.id}/${trace.id}` : null);
  let openedOn = $state<string | null>(null);
  const opened = $derived(key !== null && openedOn === key);
  const json = $derived(opened && trace && trace.output !== undefined ? JSON.stringify(trace.output, null, 2) : "");

  function duration(start: string | null, end: string | null): string | null {
    if (!start || !end) return null;
    const ms = Date.parse(end) - Date.parse(start);
    if (!Number.isFinite(ms) || ms < 0) return null;
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
  }
  const hour = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" });
</script>

<section class="output" data-testid="block-output">
  <h3>À l'exécution choisie</h3>
  {#if !chosen}
    <p class="muted">Aucune exécution pour l'instant.</p>
  {:else}
    <p class="muted">{hour(chosen.start)} · {chosen.trigger}{chosen.attempt ? " (essai)" : ""}</p>
    {#if notFound}
      <p class="muted" data-testid="execution-missing">Cette exécution n'est plus lisible.</p>
    {:else if execution?.id !== chosen.id}
      <p class="muted">Chargement…</p>
    {:else if !trace}
      <p class="muted">Ce bloc n'était pas dans cette exécution.</p>
    {:else}
      <dl>
        <dt>Statut</dt>
        <dd data-testid="block-status">{LABELS[trace.status] ?? trace.status}</dd>
        {#if duration(trace.start, trace.end)}<dt>Durée</dt><dd>{duration(trace.start, trace.end)}</dd>{/if}
        <dt>Éléments</dt>
        <dd>{trace.items ?? "—"}</dd>
      </dl>
      {#if trace.status === "resumed" && execution.attempt}
        <p class="muted" data-testid="resumed-output">Sortie reprise de l'exécution {execution.attempt.origin}</p>
      {/if}
      {#if trace.error}<p class="error" data-testid="block-run-error">{trace.error}</p>{/if}
      {#if trace.log.length > 0}
        <details>
          <summary>Journal ({trace.log.length})</summary>
          <pre data-testid="block-log">{trace.log.join("\n")}</pre>
        </details>
      {/if}
      {#if trace.output !== undefined || trace.outputTruncated}
        {#key key}
          <details data-testid="collapsible-output" open={opened} ontoggle={(e) => (openedOn = e.currentTarget.open ? key : null)}>
            <summary>Sortie{trace.outputTruncated ? " (tronquée)" : ""}</summary>
            {#if opened}<pre data-testid="json-output">{json}</pre>{/if}
          </details>
        {/key}
      {/if}
    {/if}
  {/if}
</section>

<style>
  .output { margin-top: 16px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 12px; }
  h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
  .muted { margin: 0 0 6px; color: var(--text-muted); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0 0 6px; }
  dt { color: var(--text-muted); }
  dd { margin: 0; }
  .error { margin: 0 0 6px; color: var(--in-error); white-space: pre-wrap; word-break: break-word; }
  details { margin-top: 4px; }
  summary { cursor: pointer; color: var(--text-muted); }
  pre { margin: 4px 0 0; padding: 6px 8px; max-height: 320px; overflow: auto; border-radius: 10px; border: 1px solid var(--border); background: var(--sheet); font: 11px var(--font-mono); white-space: pre-wrap; word-break: break-word; }
</style>
