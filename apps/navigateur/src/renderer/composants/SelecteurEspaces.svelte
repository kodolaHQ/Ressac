<script lang="ts">
  import Icone from "./Icone.svelte";
  import type { Espace, EtatFenetre } from "../../commun/modele";
  import { api, etat } from "../etat.svelte";
  import { ouvrirMenu } from "./menu.svelte";

  let { fenetre }: { fenetre: EtatFenetre } = $props();
  /** Formulaire de création (id null) ou de renommage d'un espace. */
  let edition = $state<{ id: string | null; nom: string; icone: string } | null>(null);
  /** Espace à supprimer en attente de confirmation (il contient des onglets). */
  let aSupprimer = $state<{ espace: Espace; onglets: number } | null>(null);

  function supprimer(espace: Espace) {
    const n = Object.values(etat.valeur?.onglets ?? {}).filter((o) => o.espaceId === espace.id).length;
    if (n > 0) aSupprimer = { espace, onglets: n };
    else api.agir({ type: "supprimerEspace", id: espace.id });
  }

  function valider(e: SubmitEvent) {
    e.preventDefault();
    if (!edition || !edition.nom.trim()) return;
    const icone = edition.icone.trim() || "📁";
    if (edition.id) api.agir({ type: "renommerEspace", id: edition.id, nom: edition.nom.trim(), icone });
    else api.agir({ type: "creerEspace", nom: edition.nom.trim(), icone, fenetreId: fenetre.id });
    edition = null;
  }
</script>

{#if aSupprimer}
  {@const { espace, onglets } = aSupprimer}
  <div class="confirmation" role="alertdialog" aria-label="Supprimer l'espace">
    <p>Supprimer l'espace « {espace.nom} » et ses {onglets} onglet{onglets > 1 ? "s" : ""} ?</p>
    <div class="boutons">
      <button onclick={() => (aSupprimer = null)}>Annuler</button>
      <button
        class="danger"
        onclick={() => {
          api.agir({ type: "supprimerEspace", id: espace.id });
          aSupprimer = null;
        }}>Supprimer</button
      >
    </div>
  </div>
{/if}
{#if edition}
  <form class="edition" onsubmit={valider}>
    <input class="icone" bind:value={edition.icone} aria-label="Icône" maxlength="4" />
    <!-- svelte-ignore a11y_autofocus -->
    <input bind:value={edition.nom} aria-label="Nom de l'espace" placeholder="Nom" autofocus onkeydown={(e) => e.key === "Escape" && (edition = null)} />
  </form>
{/if}
<nav class="espaces">
  {#each etat.valeur?.espaces ?? [] as espace (espace.id)}
    <button
      data-testid="espace-{espace.id}"
      aria-current={espace.id === fenetre.espaceActif ? "true" : undefined}
      title={espace.nom}
      onclick={() => api.agir({ type: "activerEspace", fenetreId: fenetre.id, id: espace.id })}
      oncontextmenu={(e) =>
        ouvrirMenu(e, [
          { libelle: "Renommer", agir: () => (edition = { id: espace.id, nom: espace.nom, icone: espace.icone }) },
          ...((etat.valeur?.espaces.length ?? 0) > 1 ? [{ libelle: "Supprimer", agir: () => supprimer(espace) }] : []),
        ])}>{espace.icone}</button
    >
  {/each}
  <button data-testid="nouvel-espace" title="Nouvel espace" onclick={() => (edition = { id: null, nom: "", icone: "📁" })}><Icone nom="plus" /></button>
</nav>

<style>
  .espaces { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 0; }
  .espaces button { all: unset; width: 28px; height: 28px; display: grid; place-content: center; border-radius: 6px; color: var(--texte-doux); }
  .espaces button:hover { background: var(--fond-survol); }
  .espaces button[aria-current="true"] { background: var(--fond-actif); }
  .edition { display: flex; gap: 4px; }
  .confirmation { padding: 8px; border-radius: 6px; background: var(--fond-actif); color: var(--texte); -webkit-app-region: no-drag; }
  .confirmation p { margin: 0 0 8px; }
  .boutons { display: flex; justify-content: flex-end; gap: 6px; }
  .boutons button { padding: 4px 8px; border-radius: 4px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); }
  .boutons .danger { background: #c0392b; border-color: #c0392b; color: white; }
  .edition input { min-width: 0; flex: 1; padding: 4px 6px; border-radius: 4px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); }
  .edition .icone { flex: none; width: 2.5em; text-align: center; }
</style>
