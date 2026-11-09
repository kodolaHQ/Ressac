<script lang="ts">
  import Icon from "./Icone.svelte";
  import type { Space, WindowState } from "../../shared/modele";
  import { api, appState } from "../etat.svelte";
  import { openMenu } from "./menu.svelte";
  import { losesConnections, PROFILE_TO_CHOOSE } from "./profilsEspace";
  import { spaceSettings } from "./reglagesEspace.svelte";

  let { fenetre: win }: { fenetre: WindowState } = $props();
  /** Space to delete awaiting confirmation (it contains tabs, or it takes sign-ins with it). */
  let toDelete = $state<{ espace: Space; onglets: number; connexions: boolean } | null>(null);

  function remove(space: Space) {
    const n = Object.values(appState.valeur?.onglets ?? {}).filter((o) => o.espaceId === space.id).length;
    const connexions = losesConnections(appState.valeur?.espaces ?? [], space);
    if (n > 0 || connexions) toDelete = { espace: space, onglets: n, connexions };
    else api.agir({ type: "supprimerEspace", id: space.id });
  }

  // A setting keeps the space's current profile (alone or shared); a new space has none: the user chooses.
  const set = (space: Space) =>
    (spaceSettings.brouillon = { id: space.id, nom: space.nom, icone: space.icone, prive: space.prive, profil: space.profil });
  function create() {
    spaceSettings.brouillon = { id: null, nom: "", icone: "📁", prive: false, profil: PROFILE_TO_CHOOSE };
  }
</script>

{#if toDelete}
  {@const { espace: space, onglets: tabs, connexions } = toDelete}
  <div class="confirmation" role="alertdialog" aria-label="Supprimer l'espace">
    <p>
      {#if tabs > 0}Supprimer l'espace « {space.nom} » et ses {tabs} onglet{tabs > 1 ? "s" : ""} ?{:else}Supprimer l'espace « {space.nom} » ?{/if}
      {#if connexions}Les connexions de cet espace seront perdues.{/if}
    </p>
    <div class="boutons">
      <button onclick={() => (toDelete = null)}>Annuler</button>
      <button
        class="danger"
        onclick={() => {
          api.agir({ type: "supprimerEspace", id: space.id });
          toDelete = null;
        }}>Supprimer</button
      >
    </div>
  </div>
{/if}
<nav class="espaces">
  {#each appState.valeur?.espaces ?? [] as space (space.id)}
    <button
      data-testid="espace-{space.id}"
      aria-current={space.id === win.espaceActif ? "true" : undefined}
      title={space.prive ? `${space.nom} (privé)` : space.nom}
      data-prive={space.prive || undefined}
      onclick={() => api.agir({ type: "activerEspace", fenetreId: win.id, id: space.id })}
      oncontextmenu={(e) =>
        openMenu(e, [
          { libelle: "Réglages", agir: () => set(space) },
          ...((appState.valeur?.espaces.length ?? 0) > 1 ? [{ libelle: "Supprimer", agir: () => remove(space) }] : []),
        ])}
      >{space.icone}{#if space.prive}<span class="cadenas" aria-hidden="true">🔒</span>{/if}</button
    >
  {/each}
  <button data-testid="nouvel-espace" title="Nouvel espace" onclick={create}><Icon nom="plus" /></button>
</nav>

<style>
  .espaces { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 0; }
  .espaces button { all: unset; width: 28px; height: 28px; display: grid; place-content: center; border-radius: 6px; color: var(--texte-doux); position: relative; }
  .espaces button:hover { background: var(--fond-survol); }
  .espaces button[aria-current="true"] { background: var(--fond-actif); }
  .cadenas { position: absolute; right: -3px; bottom: -3px; font-size: 9px; line-height: 1; }
  .confirmation { padding: 8px; border-radius: 6px; background: var(--fond-actif); color: var(--texte); -webkit-app-region: no-drag; }
  .confirmation p { margin: 0 0 8px; }
  .boutons { display: flex; justify-content: flex-end; gap: 6px; }
  .boutons button { padding: 4px 8px; border-radius: 4px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); }
  .boutons .danger { background: #c0392b; border-color: #c0392b; color: white; }
</style>
