<script lang="ts">
  import type { PendingRequest } from "../../shared/model";
  import type { ExtensionCard } from "../../shared/extensions";
  import { api } from "../state.svelte";

  // Everything from the manifest (name, version, sites, domains) is shown as text, never interpreted.
  let { request: request, card: card }: { request: PendingRequest; card: ExtensionCard } = $props();

  // Strengthened grant: « Activer » (and Enter, which clicks the primary button) has no effect until the box is checked.
  let included = $state(false);
  const blocked = $derived(card.hardened && !included);
  const names = (list: string[]) => list.map((n) => `« ${n} »`).join(", ");

  /** The name comes from the manifest: bounded, and shown in its own element (it cannot read as the rest of the title). */
  const NAME_MAX = 60;
  const SITES_MAX = 20;
  const name = $derived.by(() => {
    const car = [...card.name];
    return car.length > NAME_MAX ? `${car.slice(0, NAME_MAX - 1).join("")}…` : card.name;
  });
  const sites = $derived(
    card.sites.length > SITES_MAX ? `${card.sites.slice(0, SITES_MAX).join(", ")} et ${card.sites.length - SITES_MAX} autres` : card.sites.join(", "),
  );
</script>

<div data-testid="extension-request">
  {#if card.update}
    <h3>Mettre à jour <span class="name" data-testid="extension-card-name">« {name} »</span> ?</h3>
    <div class="subtle">Version {card.update.from} → {card.version}</div>
  {:else}
    <h3>Activer <span class="name" data-testid="extension-card-name">« {name} »</span> dans « {card.space} » ?</h3>
  {/if}
  <div class="subtle">{card.source === "store" ? "Chrome Web Store" : "Écrite par l'agent"}</div>

  {#if card.rights.length > 0}
    <p class="title">Ce qu'elle veut faire :</p>
    <ul>
      {#each card.rights as right, i (i)}<li>{right}</li>{/each}
    </ul>
  {/if}

  {#if card.allSites}
    <p class="alert" data-testid="extension-card-all-sites">Sur tous les sites que vous visitez</p>
  {:else if card.sites.length > 0}
    <p>Sur : {sites}</p>
  {/if}

  {#if card.otherSpaces.length > 0}
    <p>Elle sera active aussi dans {names(card.otherSpaces)} (même profil).</p>
  {/if}

  {#if card.alsoReplaces.length > 0}
    <p class="alert" data-testid="extension-card-replaces">La nouvelle version remplacera aussi celle de {names(card.alsoReplaces)}.</p>
  {/if}

  {#if card.source === "agent"}
    {#if card.network}
      <p>
        {card.network.length === 0 ? "Elle ne peut rien envoyer vers internet." : `Elle pourra envoyer des données à : ${card.network.join(", ")}.`}
      </p>
    {/if}
    <p class="subtle">
      Ses scripts tournent dans les pages : ils pourraient faire charger une ressource à la page, et ainsi faire sortir des données. Les champs de mot
      de passe lui sont masqués, sans garantie absolue.
    </p>
    <p class="subtle">L'agent ne voit pas ce que cette extension lit sur les onglets que vous ne lui avez pas partagés.</p>
  {/if}

  {#if card.hardened}
    <div class="strengthened">
      <p id="extension-card-warning">Elle pourra lire et modifier chaque page de cet espace, comptes connectés compris.</p>
      <label>
        <input type="checkbox" data-testid="extension-card-confirm" aria-describedby="extension-card-warning" bind:checked={included} />
        Je comprends : elle lira toutes les pages de cet espace
      </label>
    </div>
  {/if}

  <!-- Enter refuses (Refuser is the primary button): enabling an extension takes a real click. -->
  <div class="actions">
    <button data-main onclick={() => api.permissions.answer(request.id, "deny")}>Refuser</button>
    <button
      class="allow"
      disabled={blocked}
      aria-describedby={blocked ? "extension-card-reason" : undefined}
      onclick={() => api.permissions.answer(request.id, "allow", undefined, { confirmed: included })}>Activer</button
    >
    {#if blocked}<span id="extension-card-reason" class="sr-only">Coche « Je comprends » pour pouvoir l'activer.</span>{/if}
  </div>
</div>

<style>
  h3 { margin: 0 0 4px; font: 600 17px/1.2 var(--font-display); letter-spacing: -0.01em; overflow-wrap: anywhere; }
  p { margin: 0 0 8px; overflow-wrap: anywhere; }
  .subtle { color: var(--text-muted); font-size: 12px; margin-bottom: 8px; overflow-wrap: anywhere; }
  .title { margin-top: 8px; font-weight: 600; }
  ul { margin: 0 0 10px; padding-left: 18px; }
  li { overflow-wrap: anywhere; }
  .name { display: inline-block; max-width: 100%; padding: 0 6px; border-radius: 6px; background: var(--glass-hi); border: 1px solid var(--border); font-weight: 600; }
  .alert { color: var(--access-act); font-weight: 600; }
  .strengthened { border: 1px solid var(--in-error); background: color-mix(in srgb, var(--in-error) 14%, transparent); border-radius: 10px; padding: 8px 10px; margin: 4px 0 10px; }
  .strengthened p { color: var(--in-error); font-weight: 600; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .strengthened label { display: flex; gap: 8px; align-items: flex-start; font-weight: 600; }
  .strengthened input { margin-top: 3px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  button { padding: 7px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12.5px var(--font-ui); cursor: pointer; transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .allow { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
</style>
