<script lang="ts">
  import type { EtatFenetre, Favori } from "../../commun/modele";
  import { api, etat } from "../etat.svelte";
  import IconeSite from "./IconeSite.svelte";
  import { ouvrirMenu } from "./menu.svelte";

  let { fenetre, grand = false }: { fenetre: EtatFenetre; grand?: boolean } = $props();
  const actif = $derived.by(() => {
    const id = fenetre.actif[fenetre.espaceActif];
    return id ? etat.valeur?.onglets[id]?.lien?.id : undefined;
  });

  function ouvrir(f: Favori) {
    api.agir({ type: "ouvrirFavori", fenetreId: fenetre.id, genre: "essentiel", id: f.id });
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
  {#each etat.valeur?.essentiels ?? [] as favori (favori.id)}
    <button
      data-testid="favori-{favori.id}"
      class:actif={favori.id === actif}
      title={favori.titre}
      onclick={() => ouvrir(favori)}
      oncontextmenu={(e) => ouvrirMenu(e, [{ libelle: "Retirer", agir: () => api.agir({ type: "retirerEssentiel", favoriId: favori.id }) }])}
    >
      <IconeSite favicon={favori.favicon} titre={favori.titre} taille={grand ? 32 : 18} />
    </button>
  {/each}
</div>

<style>
  .essentiels { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; min-height: 8px; }
  .essentiels.grand { grid-template-columns: repeat(auto-fill, 64px); justify-content: center; gap: 12px; }
  button { all: unset; display: grid; place-content: center; height: 36px; border-radius: 8px; background: var(--fond-survol); }
  .grand button { height: 64px; }
  button.actif { background: var(--fond-actif); outline: 1px solid var(--accent); }
</style>
