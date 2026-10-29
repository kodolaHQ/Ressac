<script lang="ts">
  import type { DemandeEnAttente } from "../../commun/modele";
  import type { CarteExtension } from "../../commun/extensions";
  import { api } from "../etat.svelte";

  // Tout ce qui vient du manifeste (nom, version, sites, domaines) est affiché en texte, jamais interprété.
  let { demande, carte }: { demande: DemandeEnAttente; carte: CarteExtension } = $props();

  // Accord renforcé : « Activer » (et Entrée, qui clique le bouton principal) reste sans effet tant que la case n'est pas cochée.
  let compris = $state(false);
  const bloque = $derived(carte.renforce && !compris);
  const noms = (liste: string[]) => liste.map((n) => `« ${n} »`).join(", ");
</script>

<div data-testid="demande-extension">
  {#if carte.maj}
    <h3>Mettre à jour « {carte.nom} » ?</h3>
    <div class="discret">Version {carte.maj.de} → {carte.version}</div>
  {:else}
    <h3>Activer « {carte.nom} » dans « {carte.espace} » ?</h3>
  {/if}
  <div class="discret">{carte.source === "store" ? "Chrome Web Store" : "Écrite par l'agent"}</div>

  {#if carte.droits.length > 0}
    <p class="titre">Ce qu'elle veut faire :</p>
    <ul>
      {#each carte.droits as droit, i (i)}<li>{droit}</li>{/each}
    </ul>
  {/if}

  {#if carte.tousLesSites}
    <p class="alerte" data-testid="carte-extension-tous-sites">Sur tous les sites que tu visites</p>
  {:else if carte.sites.length > 0}
    <p>Sur : {carte.sites.join(", ")}</p>
  {/if}

  {#if carte.autresEspaces.length > 0}
    <p>Elle sera active aussi dans {noms(carte.autresEspaces)} (même profil).</p>
  {/if}

  {#if carte.source === "agent"}
    {#if carte.reseau}
      <p>
        {carte.reseau.length === 0 ? "Elle ne peut rien envoyer vers internet." : `Elle pourra envoyer des données à : ${carte.reseau.join(", ")}.`}
      </p>
    {/if}
    <p class="discret">
      Ses scripts tournent dans les pages : ils pourraient faire charger une ressource à la page, et ainsi faire sortir des données. Les champs de mot
      de passe lui sont masqués, sans garantie absolue.
    </p>
    <p class="discret">L'agent ne voit pas ce que cette extension lit sur les onglets que tu ne lui as pas partagés.</p>
  {/if}

  {#if carte.renforce}
    <div class="renforce">
      <p>Elle pourra lire et modifier chaque page de cet espace, comptes connectés compris.</p>
      <label>
        <input type="checkbox" data-testid="carte-extension-confirmer" bind:checked={compris} />
        Je comprends : elle lira toutes les pages de cet espace
      </label>
    </div>
  {/if}

  <div class="actions">
    <button onclick={() => api.permissions.repondre(demande.id, "refuser")}>Refuser</button>
    <button class="autoriser" data-principal disabled={bloque} onclick={() => api.permissions.repondre(demande.id, "autoriser")}>Activer</button>
  </div>
</div>

<style>
  h3 { margin: 0 0 4px; font-size: 15px; overflow-wrap: anywhere; }
  p { margin: 0 0 8px; overflow-wrap: anywhere; }
  .discret { opacity: 0.7; font-size: 12px; margin-bottom: 8px; overflow-wrap: anywhere; }
  .titre { margin-top: 8px; font-weight: 600; }
  ul { margin: 0 0 10px; padding-left: 18px; }
  li { overflow-wrap: anywhere; }
  .alerte { color: #fbbf24; font-weight: 600; }
  .renforce { border: 1px solid #ef4444; background: rgba(239, 68, 68, 0.12); border-radius: 8px; padding: 8px 10px; margin: 4px 0 10px; }
  .renforce p { color: #f87171; font-weight: 600; }
  .renforce label { display: flex; gap: 8px; align-items: flex-start; font-weight: 600; }
  .renforce input { margin-top: 3px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  button { padding: 6px 12px; border-radius: 7px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-weight: 600; font-size: 12.5px; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .autoriser { background: var(--accent); border-color: var(--accent); color: white; }
</style>
