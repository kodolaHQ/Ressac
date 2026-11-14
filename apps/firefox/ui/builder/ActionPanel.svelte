<script lang="ts">
  import type { WorkflowEdit } from "../../shared/api";
  import { t } from "../i18n.svelte";

  /**
   * The action, read-only: `action.json` is never written by Ressac (its sources, its input and its page layout
   * instruction are changed by asking the agent). Everything shows as text.
   */
  let { action }: { action: NonNullable<WorkflowEdit["action"]> | null } = $props();
</script>

<section class="action" data-testid="action-panel">
  {#if action}
    <p class="name" data-testid="action-name">{action.name}</p>
    <dl>
      <dt>{t("builder-panel-account")}</dt>
      <dd data-testid="action-account">{action.account.length ? action.account.join(", ") : t("builder-panel-none")}</dd>
      <dt>{t("builder-panel-public")}</dt>
      <dd data-testid="action-public">{action.public.length ? action.public.join(", ") : t("builder-panel-none")}</dd>
      <dt>{t("builder-panel-input")}</dt>
      <dd data-testid="action-input">{action.input ? action.input.label : t("builder-panel-none-f")}</dd>
      <dt>{t("builder-panel-layout")}</dt>
      <dd class="instruction" data-testid="action-layout">{action.layout ?? t("builder-panel-none-f")}</dd>
    </dl>
    {#if action.web}<p class="line" data-testid="action-web">{t("builder-panel-web-open")}</p>{/if}
    {#if action.maxDurationMinutes}<p class="line">{t("builder-panel-max-duration", { minutes: String(action.maxDurationMinutes) })}</p>{/if}
  {/if}
  <p class="muted">{t("builder-panel-help-action")}</p>
  <p class="muted">{t("builder-panel-select")}</p>
</section>

<style>
  .action { font-size: 12px; }
  .name { margin: 0 0 8px; font: 650 16px/1.2 var(--font-display); letter-spacing: -0.01em; word-break: break-word; }
  dl { display: grid; grid-template-columns: 1fr; gap: 2px; margin: 0 0 8px; }
  dt { color: var(--text-muted); }
  dd { margin: 0 0 6px; word-break: break-word; }
  .instruction { white-space: pre-wrap; }
  .line { margin: 0 0 6px; }
  .muted { margin: 0 0 6px; color: var(--text-muted); }
</style>
