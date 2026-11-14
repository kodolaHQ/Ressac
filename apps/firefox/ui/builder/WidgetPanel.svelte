<script lang="ts">
  import type { WorkflowEdit } from "../../shared/api";
  import { t } from "../i18n.svelte";

  /** The widget, read-only: its sources and configuration are not edited in the builder. */
  let { widget }: { widget: NonNullable<WorkflowEdit["widget"]> | null } = $props();

  const config = $derived(widget ? JSON.stringify(widget.config ?? null, null, 2) : "");
</script>

<section class="widget" data-testid="widget-panel">
  {#if widget}
    <p class="name" data-testid="widget-name">{widget.name}</p>
    <dl>
      <dt>{t("builder-panel-account")}</dt>
      <dd data-testid="widget-account">{widget.account.length ? widget.account.join(", ") : t("builder-panel-none")}</dd>
      <dt>{t("builder-panel-public")}</dt>
      <dd data-testid="widget-public">{widget.public.length ? widget.public.join(", ") : t("builder-panel-none")}</dd>
    </dl>
    {#if widget.web}<p class="line" data-testid="widget-web">{t("builder-panel-web-open")}</p>{/if}
    {#if widget.harvest?.hours.length}
      <p class="line" data-testid="widget-hours">{t("builder-panel-hours", { hours: widget.harvest.hours.join(", ") })}</p>
    {/if}
    {#if widget.harvest?.maxDurationMinutes}<p class="line">{t("builder-panel-max-duration", { minutes: String(widget.harvest.maxDurationMinutes) })}</p>{/if}
    {#if widget.harvest?.notify}<p class="line">{t("builder-panel-notify")}</p>{/if}
    <p class="label">{t("builder-panel-config")}</p>
    <pre data-testid="widget-config">{config}</pre>
  {/if}
  <p class="muted">{t("builder-panel-help-widget")}</p>
  <p class="muted">{t("builder-panel-select")}</p>
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
