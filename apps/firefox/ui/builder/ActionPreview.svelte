<script lang="ts">
  import type { PageAction } from "@webaios/kernel";
  import { NO_RESULT } from "../../shared/actions";
  import PageRender from "../action/PageRender.svelte";
  import { api } from "../state.svelte";
  import type { Executions } from "./executions.svelte";

  /**
   * The action's floating preview: the page of the run chosen in the list (a trial included), small. Reading a page
   * relaunches nothing; a trial never becomes the action's latest result there. The agent's components are not loaded
   * there (a neutral frame replaces them).
   */
  let { id, executions }: { id: string; executions: Executions } = $props();

  let loaded = $state.raw<PageAction | null | undefined>(undefined);
  /** The chosen run, and what changes its page (its end, its status). */
  const wanted = $derived(executions.choisie ? `${executions.choisie.id}|${executions.choisie.fin}|${executions.choisie.statut}` : null);
  let request = 0;
  $effect(() => {
    const v = wanted;
    const execution = executions.choisie?.id ?? null;
    const n = ++request;
    if (v === null || execution === null) {
      loaded = null;
      return;
    }
    loaded = undefined;
    void api.actions
      .page(id, execution)
      .then((p) => n === request && (loaded = p))
      .catch(() => n === request && (loaded = null));
  });
</script>

<div class="apercu" data-testid="apercu-action">
  {#if executions.choisie === null}
    <p class="doux">Aucune exécution pour l'instant.</p>
  {:else if loaded === undefined}
    <p class="doux">Chargement…</p>
  {:else if loaded === null || !loaded.page}
    <p class="doux">{loaded?.erreur ?? "Pas de page pour cette exécution."}</p>
  {:else if loaded.page.vide}
    <p class="doux">{NO_RESULT}</p>
  {:else}
    <div class="page">
      <PageRender page={loaded.page} action={id} execution={loaded.execution} composants={false} />
    </div>
  {/if}
  {#if executions.choisie?.essai}<p class="doux mention" data-testid="apercu-mention">Aperçu d'un essai : pas le dernier résultat de l'action</p>{/if}
</div>

<style>
  .apercu { position: absolute; left: 12px; bottom: 12px; z-index: 4; display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 10px; border: 1px solid var(--bord); background: var(--fond-barre); box-shadow: var(--ombre-modale); width: 480px; max-width: calc(100% - 24px); }
  .page { max-height: 360px; overflow: auto; border-radius: 6px; background: var(--fond); zoom: 0.75; }
  .doux { margin: 0; font-size: 11px; color: var(--texte-doux); }
  .mention { max-width: 360px; }
</style>
