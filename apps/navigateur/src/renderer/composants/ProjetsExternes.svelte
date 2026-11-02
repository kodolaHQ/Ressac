<script lang="ts">
  import type { EtatExternes } from "../../commun/api";
  import { api } from "../etat.svelte";

  let etat = $state<EtatExternes | null>(null);
  let requete = 0;
  /** Saisie du nom du client avant la commande ; null quand le formulaire est fermé. */
  let nom = $state<string | null>(null);
  /** La commande de branchement, affichée une fois (jeton compris) ; effacée à la fermeture. */
  let commande = $state<string | null>(null);
  let erreur = $state<string | null>(null);
  let copie = $state(false);

  async function charger() {
    const n = ++requete;
    const r = await api.externes.liste();
    if (n === requete) etat = r;
  }
  $effect(() => {
    void charger();
    return api.externes.surChange(() => void charger());
  });

  async function brancher() {
    erreur = null;
    try {
      const r = await api.externes.brancher(nom ?? "");
      commande = r.commande;
      nom = null;
      copie = false;
    } catch {
      erreur = "Le branchement a échoué.";
    }
  }
  function fermerCommande() {
    commande = null;
    copie = false;
  }
  async function copier() {
    if (commande === null) return;
    try {
      await navigator.clipboard.writeText(commande);
      copie = true;
    } catch {
      copie = false;
    }
  }
  const eteint = $derived(etat?.serveur.etat === "eteint");
</script>

<section class="externes" data-testid="projets-externes" aria-label="Projets externes">
  <h2 class="titre">Projets externes</h2>
  {#if etat}
    {#if etat.serveur.etat === "eteint"}
      <p class="raison" data-testid="raison-externes">{etat.serveur.raison}</p>
    {/if}
    <ul>
      {#each etat.projets as p (p.id)}
        <li data-testid="projet-externe">
          <div class="nom">
            <b>{p.nom}</b>
            <span>{p.dossier}</span>
          </div>
          <span class="meta">Ports {p.ports.join(", ")}</span>
          <span class="meta">{p.nomClient ?? "aucun client"}</span>
          <div class="actions">
            <button onclick={() => api.externes.relire(p.id)}>Relire</button>
            <button onclick={() => void api.externes.oublier(p.id)}>Oublier</button>
          </div>
        </li>
      {/each}
      {#each etat.clients as c (c.id)}
        <li data-testid="client-externe">
          <div class="nom">
            <b>{c.nom}</b>
            <span>Branché le {new Date(c.cree).toLocaleDateString("fr-FR")}</span>
          </div>
          <div class="actions">
            <button onclick={() => void api.externes.revoquer(c.id)}>Révoquer</button>
          </div>
        </li>
      {/each}
      {#if etat.projets.length === 0 && etat.clients.length === 0}
        <li class="aucune">Aucun Claude Code branché.</li>
      {/if}
    </ul>
  {/if}

  {#if commande !== null}
    <div class="commande">
      <p>Colle cette commande dans un terminal : elle ne sera plus affichée.</p>
      <code data-testid="commande-branchement">{commande}</code>
      <div class="actions">
        <button data-testid="copier-commande" onclick={copier}>{copie ? "Copié" : "Copier"}</button>
        <button data-testid="fermer-commande" onclick={fermerCommande}>Fermer</button>
      </div>
    </div>
  {:else if nom !== null}
    <form
      class="formulaire"
      onsubmit={(e) => {
        e.preventDefault();
        void brancher();
      }}
    >
      <label>Nom du client <input data-testid="nom-brancher" bind:value={nom} placeholder="Claude Code" maxlength="60" /></label>
      <button type="submit" data-testid="valider-brancher">Brancher</button>
      <button type="button" onclick={() => (nom = null)}>Annuler</button>
    </form>
  {:else}
    <button class="brancher" data-testid="brancher-externe" disabled={eteint || etat === null} onclick={() => (nom = "Claude Code")}>Brancher un Claude Code</button>
  {/if}
  {#if erreur}<p class="raison" role="alert">{erreur}</p>{/if}
</section>

<style>
  .externes { margin-top: 24px; }
  .titre { margin: 0 0 6px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 12px; padding: 10px 8px; border-bottom: 1px solid var(--bord); }
  li.aucune { border: none; color: var(--texte-doux); }
  .nom { flex: 1; min-width: 0; }
  .nom b { display: block; font-weight: 600; }
  .nom span { display: block; font-size: 12px; color: var(--texte-doux); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { font-size: 12px; color: var(--texte-doux); white-space: nowrap; }
  .raison { margin: 0 0 8px; color: var(--texte-doux); }
  .actions { display: flex; gap: 6px; flex: none; }
  button { padding: 4px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-size: 12px; }
  button:hover:not(:disabled) { background: var(--fond-survol); }
  button:disabled { opacity: 0.5; }
  .brancher { margin-top: 10px; }
  .commande, .formulaire { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .formulaire { flex-direction: row; align-items: center; }
  .commande p { margin: 0; }
  code { display: block; max-width: 100%; padding: 8px 10px; border-radius: 6px; background: var(--fond-survol); font-size: 12px; user-select: all; overflow-wrap: anywhere; }
  input { padding: 4px 8px; border: 1px solid var(--bord); border-radius: 6px; background: var(--fond); color: var(--texte); }
</style>
