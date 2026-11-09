<script lang="ts">
  import type { WorkflowEdit } from "../../shared/api";

  /**
   * The action, read-only: `action.json` is never written by WebAiOs (its sources, its input and its page layout
   * instruction are changed by asking the agent). Everything shows as text.
   */
  let { action }: { action: NonNullable<WorkflowEdit["action"]> | null } = $props();
</script>

<section class="action" data-testid="panneau-action">
  {#if action}
    <p class="nom" data-testid="action-nom">{action.name}</p>
    <dl>
      <dt>Domaines avec compte</dt>
      <dd data-testid="action-compte">{action.account.length ? action.account.join(", ") : "aucun"}</dd>
      <dt>Domaines publics</dt>
      <dd data-testid="action-publiques">{action.public.length ? action.public.join(", ") : "aucun"}</dd>
      <dt>Saisie demandée au lancement</dt>
      <dd data-testid="action-saisie">{action.input ? action.input.label : "aucune"}</dd>
      <dt>Consigne de mise en page</dt>
      <dd class="consigne" data-testid="action-mise-en-page">{action.layout ?? "aucune"}</dd>
    </dl>
    {#if action.web}<p class="ligne" data-testid="action-web">Accès au web : ouvert</p>{/if}
    {#if action.maxDurationMinutes}<p class="ligne">Durée maximale : {action.maxDurationMinutes} min</p>{/if}
  {/if}
  <p class="doux">Pour changer les sources, la saisie ou la mise en page, demande-le à l'agent.</p>
  <p class="doux">Sélectionne un bloc pour voir ses réglages.</p>
</section>

<style>
  .action { font-size: 12px; }
  .nom { margin: 0 0 8px; font-size: 14px; font-weight: 600; word-break: break-word; }
  dl { display: grid; grid-template-columns: 1fr; gap: 2px; margin: 0 0 8px; }
  dt { color: var(--texte-doux); }
  dd { margin: 0 0 6px; word-break: break-word; }
  .consigne { white-space: pre-wrap; }
  .ligne { margin: 0 0 6px; }
  .doux { margin: 0 0 6px; color: var(--texte-doux); }
</style>
