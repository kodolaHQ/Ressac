<script lang="ts">
  import type { ExternalsState } from "../../shared/api";
  import { api } from "../state.svelte";

  let appState = $state<ExternalsState | null>(null);
  let request = 0;
  /** Client name input before the command; null when the form is closed. */
  let name = $state<string | null>(null);
  /** The hookup command, shown once (token included); cleared on close. */
  let command = $state<string | null>(null);
  let error = $state<string | null>(null);
  let copy = $state(false);

  async function load() {
    const n = ++request;
    const r = await api.external.list();
    if (n === request) appState = r;
  }
  $effect(() => {
    void load();
    return api.external.onChange(() => void load());
  });

  async function connect() {
    error = null;
    try {
      const r = await api.external.connect(name ?? "");
      command = r.command;
      name = null;
      copy = false;
    } catch {
      error = "Le branchement a échoué.";
    }
  }
  function closeCommand() {
    command = null;
    copy = false;
  }
  async function copyCommand() {
    if (command === null) return;
    try {
      await navigator.clipboard.writeText(command);
      copy = true;
    } catch {
      copy = false;
    }
  }
  const turnedOff = $derived(appState?.server.state === "off");
</script>

<section class="externes" data-testid="projets-externes" aria-label="Projets externes">
  <h2 class="titre">Projets externes</h2>
  {#if appState}
    {#if appState.server.state === "off"}
      <p class="raison" data-testid="raison-externes">{appState.server.reason}</p>
    {/if}
    <ul>
      {#each appState.projects as p (p.id)}
        <li data-testid="projet-externe">
          <div class="nom">
            <b>{p.name}</b>
            <span>{p.folder}</span>
          </div>
          <span class="meta">Ports {p.ports.join(", ")}</span>
          <span class="meta">{p.clientName ?? "aucun client"}</span>
          <div class="actions">
            <button onclick={() => api.external.review(p.id)}>Relire</button>
            <button onclick={() => void api.external.forget(p.id)}>Oublier</button>
          </div>
        </li>
      {/each}
      {#each appState.clients as c (c.id)}
        <li data-testid="client-externe">
          <div class="nom">
            <b>{c.name}</b>
            <span>Branché le {new Date(c.created).toLocaleDateString("fr-FR")}</span>
          </div>
          <div class="actions">
            <button onclick={() => void api.external.revoke(c.id)}>Révoquer</button>
          </div>
        </li>
      {/each}
      {#if appState.projects.length === 0 && appState.clients.length === 0}
        <li class="aucune">Aucun Claude Code branché.</li>
      {/if}
    </ul>
  {/if}

  {#if command !== null}
    <div class="commande">
      <p>Colle cette commande dans un terminal : elle ne sera plus affichée.</p>
      <code data-testid="commande-branchement">{command}</code>
      <div class="actions">
        <button data-testid="copier-commande" onclick={copyCommand}>{copy ? "Copié" : "Copier"}</button>
        <button data-testid="fermer-commande" onclick={closeCommand}>Fermer</button>
      </div>
    </div>
  {:else if name !== null}
    <form
      class="formulaire"
      onsubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
    >
      <label>Nom du client <input data-testid="nom-brancher" bind:value={name} placeholder="Claude Code" maxlength="60" /></label>
      <button type="submit" data-testid="valider-brancher">Brancher</button>
      <button type="button" onclick={() => (name = null)}>Annuler</button>
    </form>
  {:else}
    <button class="brancher" data-testid="brancher-externe" disabled={turnedOff || appState === null} onclick={() => (name = "Claude Code")}>Brancher un Claude Code</button>
  {/if}
  {#if error}<p class="raison" role="alert">{error}</p>{/if}
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
