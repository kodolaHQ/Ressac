<script lang="ts">
  import type { BlocAffiche } from "../../commun/api";
  import { api } from "../etat.svelte";
  import BlocAccueil from "./BlocAccueil.svelte";

  let blocs = $state<BlocAffiche[]>([]);
  // Lectures qui se croisent (rafale de changements) : seule la dernière compte.
  let derniere = 0;
  function charger() {
    const n = ++derniere;
    api.accueil.lire().then(
      (b) => n === derniere && (blocs = b),
      () => {},
    );
  }
  $effect(() => {
    charger();
    return api.accueil.surChange(charger);
  });
</script>

{#if blocs.length}
  <section class="blocs" data-testid="accueil">
    {#each blocs as bloc (bloc.id)}
      <BlocAccueil {bloc} />
    {/each}
  </section>
{/if}

<style>
  .blocs { width: min(900px, 92%); display: flex; flex-direction: column; gap: 16px; padding-bottom: 32px; }
</style>
