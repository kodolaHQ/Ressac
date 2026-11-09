<script lang="ts">
  import type { ProfileForGrant } from "../../shared/api";

  let {
    sujet: subject,
    nom: name,
    domaines: domains,
    publiques: publics,
    profilsPourAccord: profilesForGrant,
    autoriser: allow,
    fermer: close,
  }: {
    /** What asks for the grant: a home widget or an action. */
    sujet: "widget" | "action";
    nom: string;
    domaines: string[];
    publiques: string[];
    /** The profiles offered (never a private space's), read by the subject's service. */
    profilsPourAccord: () => Promise<ProfileForGrant[]>;
    autoriser: (profile: string) => void;
    fermer: () => void;
  } = $props();

  let profiles = $state<ProfileForGrant[] | null>(null);
  let error = $state<string | null>(null);
  let chosen = $state<string | null>(null);

  $effect(() => {
    profilesForGrant().then(
      (ps) => {
        profiles = ps;
        chosen = (ps.find((p) => p.parDefaut) ?? ps[0])?.id ?? null;
      },
      (e: unknown) => (error = e instanceof Error ? e.message : String(e)),
    );
  });
</script>

<div class="voile">
  <div class="carte" role="dialog" aria-modal="true" aria-labelledby="titre-accord" data-testid="carte-accord">
    <h2 id="titre-accord">{#if subject === "action"}Autoriser l'action « {name} » à lire avec ton compte{:else}Autoriser « {name} » à lire avec ton compte{/if}</h2>
    <p data-testid="accord-compte">{subject === "action" ? "Cette action" : "Ce widget"} veut lire {domains.join(", ")} avec ton compte, connecté avec le profil choisi.</p>
    <p data-testid="accord-publiques">
      {#if publics.length}Et pourra contacter : {publics.join(", ")}.{:else}Et ne contactera aucun autre site.{/if}
    </p>
    <p>Les profils des espaces privés ne sont jamais proposés.</p>
    {#if error}
      <p class="erreur">Profils illisibles : {error}</p>
    {:else if profiles === null}
      <p>Chargement des profils…</p>
    {:else if profiles.length === 0}
      <p>Aucun profil utilisable.</p>
    {:else}
      <div class="profils" role="radiogroup">
        {#each profiles as p (p.id)}
          <label><input type="radio" name="profil-accord" value={p.id} bind:group={chosen} /> {p.libelle}</label>
        {/each}
      </div>
    {/if}
    <div class="boutons">
      <button onclick={close}>Annuler</button>
      <button class="principal" disabled={!chosen} onclick={() => chosen && allow(chosen)}>Autoriser</button>
    </div>
  </div>
</div>

<style>
  .voile { position: fixed; inset: 0; display: grid; place-content: center; background: var(--voile); z-index: 10; }
  .carte { width: min(460px, 90vw); padding: 16px 20px; border-radius: 10px; background: var(--fond-barre); border: 1px solid var(--bord); color: var(--texte); box-shadow: var(--ombre-modale); }
  h2 { margin: 0 0 8px; font-size: 15px; }
  p { margin: 0 0 12px; font-size: 13px; color: var(--texte-doux); }
  .erreur { color: var(--en-erreur); }
  .profils { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; font-size: 13px; }
  .boutons { display: flex; justify-content: flex-end; gap: 8px; }
  .boutons button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); }
  .boutons .principal { background: var(--accent); border-color: var(--accent); color: white; }
  .boutons .principal:disabled { opacity: 0.5; }
</style>
