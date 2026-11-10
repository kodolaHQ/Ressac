<script lang="ts">
  import type { WorkflowEdit } from "../../shared/api";

  /**
   * The action, read-only: `action.json` is never written by WebAiOs (its sources, its input and its page layout
   * instruction are changed by asking the agent). Everything shows as text.
   */
  let { action }: { action: NonNullable<WorkflowEdit["action"]> | null } = $props();
</script>

<section class="action" data-testid="action-panel">
  {#if action}
    <p class="name" data-testid="action-name">{action.name}</p>
    <dl>
      <dt>Domaines avec compte</dt>
      <dd data-testid="action-account">{action.account.length ? action.account.join(", ") : "aucun"}</dd>
      <dt>Domaines publics</dt>
      <dd data-testid="action-public">{action.public.length ? action.public.join(", ") : "aucun"}</dd>
      <dt>Saisie demandée au lancement</dt>
      <dd data-testid="action-input">{action.input ? action.input.label : "aucune"}</dd>
      <dt>Consigne de mise en page</dt>
      <dd class="instruction" data-testid="action-layout">{action.layout ?? "aucune"}</dd>
    </dl>
    {#if action.web}<p class="line" data-testid="action-web">Accès au web : ouvert</p>{/if}
    {#if action.maxDurationMinutes}<p class="line">Durée maximale : {action.maxDurationMinutes} min</p>{/if}
  {/if}
  <p class="muted">Pour changer les sources, la saisie ou la mise en page, demande-le à l'agent.</p>
  <p class="muted">Sélectionne un bloc pour voir ses réglages.</p>
</section>

<style>
  .action { font-size: 12px; }
  .name { margin: 0 0 8px; font-size: 14px; font-weight: 600; word-break: break-word; }
  dl { display: grid; grid-template-columns: 1fr; gap: 2px; margin: 0 0 8px; }
  dt { color: var(--text-muted); }
  dd { margin: 0 0 6px; word-break: break-word; }
  .instruction { white-space: pre-wrap; }
  .line { margin: 0 0 6px; }
  .muted { margin: 0 0 6px; color: var(--text-muted); }
</style>
