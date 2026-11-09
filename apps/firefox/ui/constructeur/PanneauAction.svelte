<script lang="ts">
  import type { EditionWorkflow } from "../../shared/api";

  /**
   * L'action, en lecture seule : `action.json` n'est jamais écrit par WebAiOs (ses sources, sa saisie et sa consigne de
   * mise en page se changent en le demandant à l'agent). Tout s'affiche en texte.
   */
  let { action }: { action: NonNullable<EditionWorkflow["action"]> | null } = $props();
</script>

<section class="action" data-testid="panneau-action">
  {#if action}
    <p class="nom" data-testid="action-nom">{action.nom}</p>
    <dl>
      <dt>Domaines avec compte</dt>
      <dd data-testid="action-compte">{action.compte.length ? action.compte.join(", ") : "aucun"}</dd>
      <dt>Domaines publics</dt>
      <dd data-testid="action-publiques">{action.publiques.length ? action.publiques.join(", ") : "aucun"}</dd>
      <dt>Saisie demandée au lancement</dt>
      <dd data-testid="action-saisie">{action.saisie ? action.saisie.libelle : "aucune"}</dd>
      <dt>Consigne de mise en page</dt>
      <dd class="consigne" data-testid="action-mise-en-page">{action.miseEnPage ?? "aucune"}</dd>
    </dl>
    {#if action.web}<p class="ligne" data-testid="action-web">Accès au web : ouvert</p>{/if}
    {#if action.dureeMaxMinutes}<p class="ligne">Durée maximale : {action.dureeMaxMinutes} min</p>{/if}
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
