<script lang="ts">
  import type { Executions } from "./executions.svelte";
  import { date, DECLENCHEURS, duree, STATUTS, TEINTES } from "./libelles";

  /** The « Exécutions » tab: the whole kept history, trials marked with their starting block. Choosing one goes back there. */
  let { executions, onchoisie }: { executions: Executions; onchoisie: () => void } = $props();

  const choisie = $derived(executions.choisie?.id ?? null);

  async function choisir(id: string): Promise<void> {
    await executions.choisir(id).catch(() => {});
    onchoisie();
  }
</script>

<section class="liste" data-testid="liste-executions">
  {#if executions.liste.length === 0}
    <p class="doux">Aucune exécution pour l'instant.</p>
  {:else}
    <ul>
      {#each executions.liste as e (e.id)}
        <li>
          <button data-testid="execution-{e.id}" class:actif={e.id === choisie} aria-pressed={e.id === choisie} onclick={() => void choisir(e.id)}>
            <span class="pastille {TEINTES[e.statut]}"></span>
            <span class="quand">{date(e.debut)}</span>
            <span>{DECLENCHEURS[e.declencheur]}</span>
            <span>{STATUTS[e.statut]}</span>
            <span class="doux">{duree(e.debut, e.fin)}</span>
            {#if e.essai}<span class="essai">essai depuis « {e.essai.depart} »</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .liste { position: absolute; inset: 0; z-index: 5; overflow-y: auto; padding: 16px 24px; background: var(--fond); color: var(--texte); font-size: 13px; }
  ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; max-width: 900px; }
  button { width: 100%; display: grid; grid-template-columns: 10px 170px 100px 110px 90px 1fr; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 6px; border: 1px solid transparent; background: none; color: var(--texte); text-align: left; font-size: 13px; }
  button:hover { background: var(--fond-survol); }
  button.actif { border-color: var(--accent); background: var(--fond-actif); }
  .pastille { width: 8px; height: 8px; border-radius: 50%; background: var(--arretee); }
  .pastille.ok { background: var(--en-marche); }
  .pastille.moyen { background: var(--en-cours); }
  .pastille.echec { background: var(--en-erreur); }
  .essai { justify-self: start; padding: 0 6px; border-radius: 4px; background: var(--fond-survol); color: var(--texte-doux); font-size: 12px; }
  .doux { color: var(--texte-doux); }
</style>
