<script lang="ts">
  import type { Executions } from "./executions.svelte";
  import { TRIGGERS, elementsEnSortie, hour, STATUSES, TINTS } from "./labels";

  /**
   * The bottom bar: the last 8 runs (choosing one updates the badges, the « Bloc » tab and the preview) and
   * « Rejouer depuis ce bloc ». A refusal shows as text under the bar.
   */
  let {
    executions,
    selection,
    sortie,
    rejouable: replayable,
  }: {
    executions: Executions;
    /** The block selected on the canvas. */
    selection: string | null;
    /** Id of the workflow's `sortie` block (its items are the run's). */
    sortie: string | undefined;
    /** The saved workflow is valid and nothing is being saved. */
    rejouable: boolean;
  } = $props();

  const last = $derived(executions.liste.slice(0, 8));
  const chosen = $derived(executions.choisie?.id ?? null);
  const elements = (n: number | null) => (n === null ? "" : `${n} élément${n > 1 ? "s" : ""}`);
</script>

<footer class="barre">
  <div class="ligne">
    <ul class="executions">
      {#each last as e (e.id)}
        <li>
          <button
            data-testid="execution-{e.id}"
            class:actif={e.id === chosen}
            aria-pressed={e.id === chosen}
            title={e.essai ? `Essai depuis « ${e.essai.depart} »` : undefined}
            onclick={() => void executions.choisir(e.id).catch(() => {})}
          >
            <span class="pastille {TINTS[e.statut]}"></span>
            <span>{hour(e.debut)}</span>
            <span class="doux">{TRIGGERS[e.declencheur]}</span>
            <span>{STATUSES[e.statut]}</span>
            {#if elements(elementsEnSortie(e, sortie))}<span class="doux">{elements(elementsEnSortie(e, sortie))}</span>{/if}
            {#if e.essai}<span class="essai">essai</span>{/if}
          </button>
        </li>
      {:else}
        <li class="doux vide">Aucune exécution pour l'instant.</li>
      {/each}
    </ul>
    <button
      class="rejouer"
      data-testid="rejouer"
      disabled={selection === null || chosen === null || executions.occupe || !replayable}
      title={selection === null ? "Sélectionne un bloc" : undefined}
      onclick={() => selection !== null && void executions.rejouer(selection).catch(() => {})}>Rejouer depuis ce bloc</button
    >
  </div>
  {#if executions.refus}<p class="refus" data-testid="refus-rejeu">{executions.refus}</p>{/if}
</footer>

<style>
  .barre { flex: none; border-top: 1px solid var(--bord); background: var(--fond-barre); padding: 6px 12px; font-size: 12px; }
  .ligne { display: flex; align-items: center; gap: 12px; }
  .executions { flex: 1; min-width: 0; display: flex; gap: 6px; margin: 0; padding: 0; list-style: none; overflow-x: auto; }
  .executions button { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); white-space: nowrap; font-size: 12px; }
  .executions button.actif { border-color: var(--accent); background: var(--fond-actif); }
  .pastille { width: 8px; height: 8px; border-radius: 50%; background: var(--arretee); flex: none; }
  .pastille.ok { background: var(--en-marche); }
  .pastille.moyen { background: var(--en-cours); }
  .pastille.echec { background: var(--en-erreur); }
  .essai { padding: 0 5px; border-radius: 4px; background: var(--fond-survol); color: var(--texte-doux); }
  .rejouer { flex: none; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); }
  .rejouer:disabled { opacity: 0.5; }
  .refus { margin: 6px 0 0; color: var(--en-erreur); white-space: pre-wrap; word-break: break-word; }
  .doux { color: var(--texte-doux); }
  .vide { padding: 4px 0; }
</style>
