<script lang="ts">
  import BarreLaterale from "./composants/BarreLaterale.svelte";
  import MenuContextuel from "./composants/MenuContextuel.svelte";
  import ZoneContenu from "./composants/ZoneContenu.svelte";
  import type { Panneau } from "../commun/api";
  import { api, etat, fenetreCourante } from "./etat.svelte";

  const MASQUAGE_MS = 300;
  const BORD_GAUCHE = 8;

  const fenetre = $derived(fenetreCourante());
  const panneauAgentOuvert = $derived(fenetre?.panneauAgentOuvert ?? false);
  const ongletActif = $derived.by(() => {
    const id = fenetre?.actif[fenetre.espaceActif];
    return id ? etat.valeur?.onglets[id] : undefined;
  });

  // Mode compact : la barre réapparaît quand la souris touche le bord gauche. Une page web couvrant
  // toujours l'interface, la barre « révélée » reprend sa colonne le temps du survol.
  const compact = $derived(fenetre?.compact ?? false);
  let revelee = $state(false);
  let survolBarre = false;
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const barreVisible = $derived(!compact || revelee);

  function reveler() {
    clearTimeout(minuterie);
    if (compact) revelee = true;
  }
  function planifierMasquage() {
    clearTimeout(minuterie);
    if (!revelee || survolBarre) return;
    minuterie = setTimeout(() => {
      if (!survolBarre) revelee = false;
    }, MASQUAGE_MS);
  }

  let panneau = $state<Panneau | null>(null);
  const basculerPanneau = (p: Panneau) => (panneau = panneau === p ? null : p);
  $effect(() => api.surPanneau(basculerPanneau));
  // Activer un onglet referme le panneau.
  $effect(() => {
    void ongletActif?.id;
    panneau = null;
  });

  $effect(() => api.surBordGauche((dedans) => (dedans ? reveler() : planifierMasquage())));
  $effect(() => {
    if (!compact) revelee = false;
  });
</script>

<svelte:window onmousemove={(e) => compact && !revelee && e.clientX < BORD_GAUCHE && reveler()} />

<div class="fenetre" class:compact={!barreVisible} class:agent={panneauAgentOuvert}>
  {#if fenetre}
    <BarreLaterale
      {fenetre}
      cachee={!barreVisible}
      {basculerPanneau}
      surEntree={() => {
        survolBarre = true;
        clearTimeout(minuterie);
      }}
      surSortie={() => {
        survolBarre = false;
        planifierMasquage();
      }}
    />
  {:else}
    <aside data-testid="barre-laterale"></aside>
  {/if}
  <ZoneContenu {fenetre} onglet={ongletActif} {panneau} fermerPanneau={() => (panneau = null)} />
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
  .fenetre.compact { grid-template-columns: 1fr; }
  .fenetre.compact.agent { grid-template-columns: 1fr 420px; }
  .agent { background: var(--fond-barre); border-left: 1px solid var(--bord); }
</style>
