<script lang="ts">
  import type { WorkflowEdit } from "../../shared/api";

  /** The widget, read-only: its sources and configuration are not edited in the builder. */
  let { widget }: { widget: NonNullable<WorkflowEdit["widget"]> | null } = $props();

  const config = $derived(widget ? JSON.stringify(widget.config ?? null, null, 2) : "");
</script>

<section class="widget" data-testid="widget-panel">
  {#if widget}
    <p class="name" data-testid="widget-name">{widget.name}</p>
    <dl>
      <dt>Domaines avec compte</dt>
      <dd data-testid="widget-account">{widget.account.length ? widget.account.join(", ") : "aucun"}</dd>
      <dt>Domaines publics</dt>
      <dd data-testid="widget-public">{widget.public.length ? widget.public.join(", ") : "aucun"}</dd>
    </dl>
    {#if widget.web}<p class="line" data-testid="widget-web">Accès au web : ouvert</p>{/if}
    {#if widget.harvest?.hours.length}
      <p class="line" data-testid="widget-hours">Heures prévues : {widget.harvest.hours.join(", ")}</p>
    {/if}
    {#if widget.harvest?.maxDurationMinutes}<p class="line">Durée maximale : {widget.harvest.maxDurationMinutes} min</p>{/if}
    {#if widget.harvest?.notify}<p class="line">Notification à la fin : oui</p>{/if}
    <p class="label">Configuration</p>
    <pre data-testid="widget-config">{config}</pre>
  {/if}
  <p class="muted">Pour changer les sources ou la configuration, demande-le à l'agent.</p>
  <p class="muted">Sélectionne un bloc pour voir ses réglages.</p>
</section>

<style>
  .widget { font-size: 12px; }
  .name { margin: 0 0 8px; font: 650 16px/1.2 var(--font-display); letter-spacing: -0.01em; word-break: break-word; }
  dl { display: grid; grid-template-columns: 1fr; gap: 2px; margin: 0 0 8px; }
  dt { color: var(--text-muted); }
  dd { margin: 0 0 6px; word-break: break-word; }
  .line { margin: 0 0 6px; }
  .label { margin: 0; color: var(--text-muted); }
  pre { margin: 4px 0 10px; padding: 6px 8px; max-height: 260px; overflow: auto; border-radius: 10px; border: 1px solid var(--border); background: var(--sheet); font: 11px var(--font-mono); white-space: pre-wrap; word-break: break-word; }
  .muted { margin: 0 0 6px; color: var(--text-muted); }
</style>
