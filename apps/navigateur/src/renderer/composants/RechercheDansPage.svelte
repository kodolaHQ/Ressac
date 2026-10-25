<script lang="ts">
  import type { Onglet } from "../../commun/modele";
  import { api } from "../etat.svelte";
  import { recherche } from "./recherche.svelte";

  let { onglet }: { onglet: Onglet } = $props();
  let texte = $state("");
  let champ: HTMLInputElement;
  const resultat = $derived(recherche.resultat?.ongletId === onglet.id ? recherche.resultat : null);

  $effect(() => {
    void recherche.focus;
    champ.focus();
    champ.select();
  });

  $effect(() => {
    const { n, precedent } = recherche.pas;
    if (n && texte) api.commande(onglet.id, { chercher: texte, suivant: !precedent, precedent });
  });

  function fermer() {
    api.commande(onglet.id, "finRecherche");
    recherche.ouverte = false;
    recherche.resultat = null;
  }
</script>

<div class="recherche" role="search">
  <input
    bind:this={champ}
    bind:value={texte}
    data-testid="recherche-page"
    placeholder="Rechercher dans la page"
    spellcheck="false"
    oninput={() => api.commande(onglet.id, { chercher: texte })}
    onkeydown={(e) => {
      if (e.key === "Escape") fermer();
      else if (e.key === "Enter" && texte) api.commande(onglet.id, { chercher: texte, suivant: !e.shiftKey, precedent: e.shiftKey });
    }}
  />
  <span class="compteur" data-testid="compteur-recherche">{texte && resultat ? `${resultat.actif}/${resultat.total}` : ""}</span>
  <button aria-label="Fermer la recherche" onclick={fermer}>✕</button>
</div>

<style>
  .recherche { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 6px 12px; background: var(--fond-barre); border-bottom: 1px solid var(--bord); }
  input { width: 240px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--accent); background: var(--fond); color: var(--texte); outline: none; }
  .compteur { min-width: 3em; color: var(--texte-doux); font-variant-numeric: tabular-nums; }
  button { all: unset; padding: 0 4px; color: var(--texte-doux); }
</style>
