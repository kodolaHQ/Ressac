<script lang="ts">
  import type { WindowState, Favorite } from "../../shared/modele";
  import { api, appState } from "../etat.svelte";
  import SiteIcon from "./IconeSite.svelte";
  import { openMenu } from "./menu.svelte";

  let { fenetre: win, grand = false }: { fenetre: WindowState; grand?: boolean } = $props();
  const active = $derived.by(() => {
    const id = win.actif[win.espaceActif];
    return id ? appState.valeur?.onglets[id]?.lien?.id : undefined;
  });

  function open(f: Favorite) {
    api.agir({ type: "ouvrirFavori", fenetreId: win.id, genre: "essentiel", id: f.id });
  }
</script>

<div
  class="essentiels"
  class:grand
  data-testid={grand ? "essentiels-page-vide" : "essentiels"}
  role="group"
  aria-label="Essentiels"
  ondragover={(e) => e.dataTransfer?.types.includes("application/x-webaios-onglet") && e.preventDefault()}
  ondrop={(e) => {
    const id = e.dataTransfer?.getData("application/x-webaios-onglet");
    if (id) api.agir({ type: "ajouterEssentiel", id });
  }}
>
  {#each appState.valeur?.essentiels ?? [] as favorite (favorite.id)}
    <button
      data-testid="favori-{favorite.id}"
      class:actif={favorite.id === active}
      title={favorite.titre}
      onclick={() => open(favorite)}
      oncontextmenu={(e) => openMenu(e, [{ libelle: "Retirer", agir: () => api.agir({ type: "retirerEssentiel", favoriId: favorite.id }) }])}
    >
      <SiteIcon favicon={favorite.favicon} titre={favorite.titre} taille={grand ? 32 : 18} />
    </button>
  {/each}
</div>

<style>
  .essentiels { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; min-height: 8px; }
  .essentiels.grand { grid-template-columns: repeat(auto-fill, 64px); justify-content: center; gap: 12px; }
  button { all: unset; display: grid; place-content: center; height: 44px; border-radius: 10px; background: var(--fond-survol); }
  .grand button { height: 64px; }
  /* Inside the box: the sidebar's scroll area clips what sticks out. */
  button.actif { background: var(--fond-actif); outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
