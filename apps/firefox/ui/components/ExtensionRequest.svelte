<script lang="ts">
  import type { PendingRequest } from "../../shared/model";
  import type { CarteExtension } from "../../shared/extensions";
  import { api } from "../state.svelte";

  // Everything from the manifest (name, version, sites, domains) is shown as text, never interpreted.
  let { demande: request, carte }: { demande: PendingRequest; carte: CarteExtension } = $props();

  // Strengthened grant: « Activer » (and Enter, which clicks the primary button) has no effect until the box is checked.
  let included = $state(false);
  const blocked = $derived(carte.renforce && !included);
  const names = (list: string[]) => list.map((n) => `« ${n} »`).join(", ");

  /** The name comes from the manifest: bounded, and shown in its own element (it cannot read as the rest of the title). */
  const NAME_MAX = 60;
  const SITES_MAX = 20;
  const name = $derived.by(() => {
    const car = [...carte.nom];
    return car.length > NAME_MAX ? `${car.slice(0, NAME_MAX - 1).join("")}…` : carte.nom;
  });
  const sites = $derived(
    carte.sites.length > SITES_MAX ? `${carte.sites.slice(0, SITES_MAX).join(", ")} et ${carte.sites.length - SITES_MAX} autres` : carte.sites.join(", "),
  );
</script>

<div data-testid="demande-extension">
  {#if carte.maj}
    <h3>Mettre à jour <span class="nom" data-testid="carte-extension-nom">« {name} »</span> ?</h3>
    <div class="discret">Version {carte.maj.de} → {carte.version}</div>
  {:else}
    <h3>Activer <span class="nom" data-testid="carte-extension-nom">« {name} »</span> dans « {carte.espace} » ?</h3>
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
    <p>Sur : {sites}</p>
  {/if}

  {#if carte.autresEspaces.length > 0}
    <p>Elle sera active aussi dans {names(carte.autresEspaces)} (même profil).</p>
  {/if}

  {#if carte.remplaceAussi.length > 0}
    <p class="alerte" data-testid="carte-extension-remplace">La nouvelle version remplacera aussi celle de {names(carte.remplaceAussi)}.</p>
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
      <p id="carte-extension-avertissement">Elle pourra lire et modifier chaque page de cet espace, comptes connectés compris.</p>
      <label>
        <input type="checkbox" data-testid="carte-extension-confirmer" aria-describedby="carte-extension-avertissement" bind:checked={included} />
        Je comprends : elle lira toutes les pages de cet espace
      </label>
    </div>
  {/if}

  <!-- Enter refuses (Refuser is the primary button): enabling an extension takes a real click. -->
  <div class="actions">
    <button data-principal onclick={() => api.permissions.repondre(request.id, "refuser")}>Refuser</button>
    <button
      class="autoriser"
      disabled={blocked}
      aria-describedby={blocked ? "carte-extension-raison" : undefined}
      onclick={() => api.permissions.repondre(request.id, "autoriser", undefined, { confirme: included })}>Activer</button
    >
    {#if blocked}<span id="carte-extension-raison" class="lecteur">Coche « Je comprends » pour pouvoir l'activer.</span>{/if}
  </div>
</div>

<style>
  h3 { margin: 0 0 4px; font-size: 15px; overflow-wrap: anywhere; }
  p { margin: 0 0 8px; overflow-wrap: anywhere; }
  .discret { opacity: 0.7; font-size: 12px; margin-bottom: 8px; overflow-wrap: anywhere; }
  .titre { margin-top: 8px; font-weight: 600; }
  ul { margin: 0 0 10px; padding-left: 18px; }
  li { overflow-wrap: anywhere; }
  .nom { display: inline-block; max-width: 100%; padding: 0 5px; border-radius: 5px; background: var(--fond-barre); border: 1px solid var(--bord); font-weight: 600; }
  .alerte { color: var(--acces-agir); font-weight: 600; }
  .renforce { border: 1px solid var(--en-erreur); background: color-mix(in srgb, var(--en-erreur) 14%, transparent); border-radius: 8px; padding: 8px 10px; margin: 4px 0 10px; }
  .renforce p { color: var(--en-erreur); font-weight: 600; }
  .lecteur { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .renforce label { display: flex; gap: 8px; align-items: flex-start; font-weight: 600; }
  .renforce input { margin-top: 3px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  button { padding: 6px 12px; border-radius: 7px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-weight: 600; font-size: 12.5px; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .autoriser { background: var(--accent); border-color: var(--accent); color: white; }
</style>
