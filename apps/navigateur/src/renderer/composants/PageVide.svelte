<script lang="ts">
  import type { EtatFenetre } from "../../commun/modele";
  import { api } from "../etat.svelte";
  import { adresse } from "./adresse.svelte";
  import Accueil from "./Accueil.svelte";
  import Essentiels from "./Essentiels.svelte";
  import IaLocale from "./IaLocale.svelte";

  let { fenetre }: { fenetre: EtatFenetre } = $props();
  let saisie = $state("");
  let champ: HTMLInputElement;

  $effect(() => {
    void adresse.focus;
    champ.focus();
  });
</script>

<div class="page-vide" data-testid="page-vide">
  <div class="ia-locale"><IaLocale /></div>
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
  <Accueil />
</div>

<style>
  .page-vide { position: relative; display: flex; flex-direction: column; align-items: center; gap: 32px; padding-top: 12vh; height: 100%; box-sizing: border-box; overflow-y: auto; }
  .ia-locale { position: absolute; top: 12px; right: 16px; }
  form { width: min(560px, 80%); }
  input { width: 100%; box-sizing: border-box; padding: 12px 16px; font-size: 16px; border-radius: 10px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); outline: none; }
  input:focus { border-color: var(--accent); }
  .page-vide :global([data-testid="essentiels-page-vide"]) { width: min(560px, 80%); }
</style>
