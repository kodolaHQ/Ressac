<script lang="ts">
  import type { EtatFenetre } from "../../commun/modele";
  import { api, etat } from "../etat.svelte";
  import Essentiels from "./Essentiels.svelte";
  import IconeSite from "./IconeSite.svelte";
  import ListeOnglets from "./ListeOnglets.svelte";
  import { ouvrirMenu } from "./menu.svelte";
  import SelecteurEspaces from "./SelecteurEspaces.svelte";

  let { fenetre }: { fenetre: EtatFenetre } = $props();
  const espace = $derived(etat.valeur?.espaces.find((e) => e.id === fenetre.espaceActif));
  const lienActif = $derived.by(() => {
    const id = fenetre.actif[fenetre.espaceActif];
    return id ? etat.valeur?.onglets[id]?.lien?.id : undefined;
  });
</script>

<aside class="barre" data-testid="barre-laterale">
  <div class="defilant">
    <Essentiels {fenetre} />
    <ul
      class="epingles"
      data-testid="epingles"
      ondragover={(e) => e.dataTransfer?.types.includes("application/x-webaios-onglet") && e.preventDefault()}
      ondrop={(e) => {
        const id = e.dataTransfer?.getData("application/x-webaios-onglet");
        if (id) api.agir({ type: "epinglerOnglet", id });
      }}
    >
      {#each espace?.epingles ?? [] as favori (favori.id)}
        <li>
          <button
            data-testid="favori-{favori.id}"
            class:actif={favori.id === lienActif}
            onclick={() => api.agir({ type: "ouvrirFavori", fenetreId: fenetre.id, genre: "epingle", id: favori.id })}
            oncontextmenu={(e) =>
              ouvrirMenu(e, [{ libelle: "Retirer", agir: () => api.agir({ type: "desepingler", espaceId: fenetre.espaceActif, favoriId: favori.id }) }])}
          >
            <IconeSite favicon={favori.favicon} titre={favori.titre} />
            <span>{favori.titre}</span>
          </button>
        </li>
      {/each}
    </ul>
    <hr />
    <ListeOnglets {fenetre} />
    <button class="nouveau" data-testid="nouvel-onglet" onclick={() => api.agir({ type: "afficherPageVide", fenetreId: fenetre.id })}>+ Nouvel onglet</button>
  </div>
  <SelecteurEspaces {fenetre} />
</aside>

<style>
  .barre {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 38px 8px 0; /* boutons de fenêtre macOS */
    background: var(--fond-barre);
    -webkit-app-region: drag;
  }
  .defilant { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; -webkit-app-region: no-drag; }
  .barre :global(nav) { -webkit-app-region: no-drag; }
  .epingles { list-style: none; margin: 0; padding: 0; min-height: 8px; }
  .epingles button { all: unset; display: flex; align-items: center; gap: 8px; width: calc(100% - 12px); height: 32px; padding: 0 6px; border-radius: 6px; color: var(--texte); }
  .epingles button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .epingles button:hover { background: var(--fond-survol); }
  .epingles button.actif { background: var(--fond-actif); }
  hr { width: 100%; border: none; border-top: 1px solid var(--bord); margin: 2px 0; }
  .nouveau { all: unset; padding: 6px; border-radius: 6px; color: var(--texte-doux); }
  .nouveau:hover { background: var(--fond-survol); }
</style>
