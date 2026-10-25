<script lang="ts">
  let panneauAgentOuvert = $state(false);
</script>

<div class="fenetre" class:agent={panneauAgentOuvert}>
  <aside class="barre" data-testid="barre-laterale"></aside>
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
  }
  .contenu { background: var(--fond); }
  .agent { background: var(--fond-barre); border-left: 1px solid var(--bord); }
</style>
