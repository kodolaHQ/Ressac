<script lang="ts">
  import ZoneContenu from "./composants/ZoneContenu.svelte";
  import { api, etat, fenetreCourante } from "./etat.svelte";

  const fenetre = $derived(fenetreCourante());
  const panneauAgentOuvert = $derived(fenetre?.panneauAgentOuvert ?? false);
  const ordre = $derived(fenetre ? (fenetre.ordre[fenetre.espaceActif] ?? []) : []);
  const actif = $derived(fenetre ? fenetre.actif[fenetre.espaceActif] : null);
  const ongletActif = $derived(actif ? etat.valeur?.onglets[actif] : undefined);
</script>

<div class="fenetre" class:agent={panneauAgentOuvert}>
  <aside class="barre" data-testid="barre-laterale">
    <ul class="onglets">
      {#each ordre as id (id)}
        {@const onglet = etat.valeur?.onglets[id]}
        {#if onglet}
          <li>
            <button data-testid="onglet-{id}" class:actif={id === actif} onclick={() => api.agir({ type: "activerOnglet", id })}>{onglet.titre}</button>
          </li>
        {/if}
      {/each}
    </ul>
    <nav class="espaces">
      {#each etat.valeur?.espaces ?? [] as espace (espace.id)}
        <span data-testid="espace-{espace.id}" class:actif={espace.id === fenetre?.espaceActif} title={espace.nom}>{espace.icone}</span>
      {/each}
    </nav>
  </aside>
  <ZoneContenu onglet={ongletActif} />
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
  .onglets { list-style: none; margin: 0; padding: 0 8px; -webkit-app-region: no-drag; }
  .onglets button { all: unset; display: block; width: 100%; padding: 4px 6px; border-radius: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--texte); }
  .onglets button.actif { background: var(--survol, rgba(127, 127, 127, 0.18)); }
  .espaces { margin-top: auto; display: flex; gap: 8px; padding: 8px; }
  .espaces .actif { outline: 1px solid var(--bord); border-radius: 4px; }
  .agent { background: var(--fond-barre); border-left: 1px solid var(--bord); }
</style>
