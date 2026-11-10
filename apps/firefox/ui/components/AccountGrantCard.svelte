<script lang="ts">
  import type { ProfileForGrant } from "../../shared/api";

  let {
    subject: subject,
    name: name,
    domains: domains,
    public: publics,
    profilesForGrant: profilesForGrant,
    allow: allow,
    close: close,
  }: {
    /** What asks for the grant: a home widget or an action. */
    subject: "widget" | "action";
    name: string;
    domains: string[];
    public: string[];
    /** The profiles offered (never a private space's), read by the subject's service. */
    profilesForGrant: () => Promise<ProfileForGrant[]>;
    allow: (profile: string) => void;
    close: () => void;
  } = $props();

  let profiles = $state<ProfileForGrant[] | null>(null);
  let error = $state<string | null>(null);
  let chosen = $state<string | null>(null);

  $effect(() => {
    profilesForGrant().then(
      (ps) => {
        profiles = ps;
        chosen = (ps.find((p) => p.isDefault) ?? ps[0])?.id ?? null;
      },
      (e: unknown) => (error = e instanceof Error ? e.message : String(e)),
    );
  });
</script>

<div class="veil">
  <div class="card" role="dialog" aria-modal="true" aria-labelledby="grant-title" data-testid="grant-card">
    <h2 id="grant-title">{#if subject === "action"}Autoriser l'action « {name} » à lire avec ton compte{:else}Autoriser « {name} » à lire avec ton compte{/if}</h2>
    <p data-testid="grant-account">{subject === "action" ? "Cette action" : "Ce widget"} veut lire {domains.join(", ")} avec ton compte, connecté avec le profil choisi.</p>
    <p data-testid="grant-public">
      {#if publics.length}Et pourra contacter : {publics.join(", ")}.{:else}Et ne contactera aucun autre site.{/if}
    </p>
    <p>Les profils des espaces privés ne sont jamais proposés.</p>
    {#if error}
      <p class="error">Profils illisibles : {error}</p>
    {:else if profiles === null}
      <p>Chargement des profils…</p>
    {:else if profiles.length === 0}
      <p>Aucun profil utilisable.</p>
    {:else}
      <div class="profiles" role="radiogroup">
        {#each profiles as p (p.id)}
          <label><input type="radio" name="grant-profile" value={p.id} bind:group={chosen} /> {p.label}</label>
        {/each}
      </div>
    {/if}
    <div class="buttons">
      <button onclick={close}>Annuler</button>
      <button class="main" disabled={!chosen} onclick={() => chosen && allow(chosen)}>Autoriser</button>
    </div>
  </div>
</div>

<style>
  .veil { position: fixed; inset: 0; display: grid; place-content: center; background: var(--veil); z-index: 10; }
  .card { width: min(460px, 90vw); padding: 16px 20px; border-radius: 10px; background: var(--bg-bar); border: 1px solid var(--border); color: var(--text); box-shadow: var(--modal-shadow); }
  h2 { margin: 0 0 8px; font-size: 15px; }
  p { margin: 0 0 12px; font-size: 13px; color: var(--text-muted); }
  .error { color: var(--in-error); }
  .profiles { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; font-size: 13px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .buttons button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
  .buttons .main { background: var(--accent); border-color: var(--accent); color: white; }
  .buttons .main:disabled { opacity: 0.5; }
</style>
