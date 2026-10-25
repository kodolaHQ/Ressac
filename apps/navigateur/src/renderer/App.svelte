<script lang="ts">
  import { etat, fenetreCourante } from "./etat.svelte";

  const fenetre = $derived(fenetreCourante());
  const panneauAgentOuvert = $derived(fenetre?.panneauAgentOuvert ?? false);
</script>

<div class="fenetre" class:agent={panneauAgentOuvert}>
  <aside class="barre" data-testid="barre-laterale">
    <nav class="espaces">
      {#each etat.valeur?.espaces ?? [] as espace (espace.id)}
        <span data-testid="espace-{espace.id}" class:actif={espace.id === fenetre?.espaceActif} title={espace.nom}>{espace.icone}</span>
      {/each}
    </nav>
  </aside>
  <main class="contenu" data-testid="zone-contenu"></main>
  <section class="agent" data-testid="panneau-agent" hidden={!panneauAgentOuvert}></section>
</div>

<style>
  .fenetre {
    display: grid;
    grid-template-columns: 240px 1fr;
    height: 100%;
  }
  .fenetre.agent { grid-template-columns: 240px 1fr 420px; }
  .barre {
    background: var(--fond-barre);
    padding-top: 38px; /* boutons de fenêtre macOS */
    -webkit-app-region: drag;
    display: flex;
    flex-direction: column;
  }
  .espaces { margin-top: auto; display: flex; gap: 8px; padding: 8px; }
  .espaces .actif { outline: 1px solid var(--bord); border-radius: 4px; }
  .contenu { background: var(--fond); }
  .agent { background: var(--fond-barre); border-left: 1px solid var(--bord); }
</style>
