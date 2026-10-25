<script lang="ts">
  import type { EtatFenetre } from "../../commun/modele";
  import { api } from "../etat.svelte";
  import Essentiels from "./Essentiels.svelte";

  let { fenetre }: { fenetre: EtatFenetre } = $props();
  let saisie = $state("");
  let champ: HTMLInputElement;

  $effect(() => champ.focus());
</script>

<div class="page-vide" data-testid="page-vide">
  <form
    onsubmit={(e) => {
      e.preventDefault();
      if (saisie.trim()) api.naviguer(null, saisie.trim());
      saisie = "";
    }}
  >
    <input bind:this={champ} bind:value={saisie} data-testid="saisie-page-vide" placeholder="Rechercher ou saisir une adresse" spellcheck="false" />
  </form>
  <Essentiels {fenetre} grand />
</div>

<style>
  .page-vide { display: flex; flex-direction: column; align-items: center; gap: 32px; padding-top: 22vh; height: 100%; box-sizing: border-box; }
  form { width: min(560px, 80%); }
  input { width: 100%; box-sizing: border-box; padding: 12px 16px; font-size: 16px; border-radius: 10px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); outline: none; }
  input:focus { border-color: var(--accent); }
  .page-vide :global([data-testid="essentiels-page-vide"]) { width: min(560px, 80%); }
</style>
