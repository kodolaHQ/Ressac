<script lang="ts">
  import type { EditionWorkflow } from "../../commun/api";

  /** Le widget, en lecture seule : ses sources et sa configuration ne s'éditent pas dans le constructeur. */
  let { widget }: { widget: NonNullable<EditionWorkflow["widget"]> | null } = $props();

  const config = $derived(widget ? JSON.stringify(widget.config ?? null, null, 2) : "");
</script>

<section class="widget" data-testid="panneau-widget">
  {#if widget}
    <p class="nom" data-testid="widget-nom">{widget.nom}</p>
    <dl>
      <dt>Domaines avec compte</dt>
      <dd data-testid="widget-compte">{widget.compte.length ? widget.compte.join(", ") : "aucun"}</dd>
      <dt>Domaines publics</dt>
      <dd data-testid="widget-publiques">{widget.publiques.length ? widget.publiques.join(", ") : "aucun"}</dd>
    </dl>
    {#if widget.web}<p class="ligne" data-testid="widget-web">Accès au web : ouvert</p>{/if}
    {#if widget.recolte?.heures.length}
      <p class="ligne" data-testid="widget-heures">Heures prévues : {widget.recolte.heures.join(", ")}</p>
    {/if}
    {#if widget.recolte?.dureeMaxMinutes}<p class="ligne">Durée maximale : {widget.recolte.dureeMaxMinutes} min</p>{/if}
    {#if widget.recolte?.notifier}<p class="ligne">Notification à la fin : oui</p>{/if}
    <p class="libelle">Configuration</p>
    <pre data-testid="widget-config">{config}</pre>
  {/if}
  <p class="doux">Pour changer les sources ou la configuration, demande-le à l'agent.</p>
  <p class="doux">Sélectionne un bloc pour voir ses réglages.</p>
</section>

<style>
  .widget { font-size: 12px; }
  .nom { margin: 0 0 8px; font-size: 14px; font-weight: 600; word-break: break-word; }
  dl { display: grid; grid-template-columns: 1fr; gap: 2px; margin: 0 0 8px; }
  dt { color: var(--texte-doux); }
  dd { margin: 0 0 6px; word-break: break-word; }
  .ligne { margin: 0 0 6px; }
  .libelle { margin: 0; color: var(--texte-doux); }
  pre { margin: 4px 0 10px; padding: 6px 8px; max-height: 260px; overflow: auto; border-radius: 6px; background: var(--fond); font-size: 11px; white-space: pre-wrap; word-break: break-word; }
  .doux { margin: 0 0 6px; color: var(--texte-doux); }
</style>
