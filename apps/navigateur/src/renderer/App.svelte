<script lang="ts">
  import BarreLaterale from "./composants/BarreLaterale.svelte";
  import MenuContextuel from "./composants/MenuContextuel.svelte";
  import ZoneContenu from "./composants/ZoneContenu.svelte";
  import { etat, fenetreCourante } from "./etat.svelte";

  const fenetre = $derived(fenetreCourante());
  const panneauAgentOuvert = $derived(fenetre?.panneauAgentOuvert ?? false);
  const ongletActif = $derived.by(() => {
    const id = fenetre?.actif[fenetre.espaceActif];
    return id ? etat.valeur?.onglets[id] : undefined;
  });
</script>

<div class="fenetre" class:agent={panneauAgentOuvert}>
  {#if fenetre}
    <BarreLaterale {fenetre} />
  {:else}
    <aside data-testid="barre-laterale"></aside>
  {/if}
  <ZoneContenu {fenetre} onglet={ongletActif} />
  <section class="agent" data-testid="panneau-agent" hidden={!panneauAgentOuvert}></section>
</div>
<MenuContextuel />

<style>
  .fenetre {
    display: grid;
    grid-template-columns: 240px 1fr;
    height: 100%;
  }
  .fenetre.agent { grid-template-columns: 240px 1fr 420px; }
  .agent { background: var(--fond-barre); border-left: 1px solid var(--bord); }
</style>
