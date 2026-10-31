<script lang="ts">
  import type { ProfilPourAccord } from "../../commun/api";

  let {
    sujet,
    nom,
    domaines,
    publiques,
    profilsPourAccord,
    autoriser,
    fermer,
  }: {
    /** Ce qui demande l'accord : un widget de l'accueil ou une action. */
    sujet: "widget" | "action";
    nom: string;
    domaines: string[];
    publiques: string[];
    /** Les profils proposés (jamais celui d'un espace privé), lus par le service du sujet. */
    profilsPourAccord: () => Promise<ProfilPourAccord[]>;
    autoriser: (profil: string) => void;
    fermer: () => void;
  } = $props();

  let profils = $state<ProfilPourAccord[] | null>(null);
  let erreur = $state<string | null>(null);
  let choisi = $state<string | null>(null);

  $effect(() => {
    profilsPourAccord().then(
      (ps) => {
        profils = ps;
        choisi = (ps.find((p) => p.parDefaut) ?? ps[0])?.id ?? null;
      },
      (e: unknown) => (erreur = e instanceof Error ? e.message : String(e)),
    );
  });
</script>

<div class="voile">
  <div class="carte" role="dialog" aria-modal="true" aria-labelledby="titre-accord" data-testid="carte-accord">
    <h2 id="titre-accord">{#if sujet === "action"}Autoriser l'action « {nom} » à lire avec ton compte{:else}Autoriser « {nom} » à lire avec ton compte{/if}</h2>
    <p data-testid="accord-compte">{sujet === "action" ? "Cette action" : "Ce widget"} veut lire {domaines.join(", ")} avec ton compte, connecté avec le profil choisi.</p>
    <p data-testid="accord-publiques">
      {#if publiques.length}Et pourra contacter : {publiques.join(", ")}.{:else}Et ne contactera aucun autre site.{/if}
    </p>
    <p>Les profils des espaces privés ne sont jamais proposés.</p>
    {#if erreur}
      <p class="erreur">Profils illisibles : {erreur}</p>
    {:else if profils === null}
      <p>Chargement des profils…</p>
    {:else if profils.length === 0}
      <p>Aucun profil utilisable.</p>
    {:else}
      <div class="profils" role="radiogroup">
        {#each profils as p (p.id)}
          <label><input type="radio" name="profil-accord" value={p.id} bind:group={choisi} /> {p.libelle}</label>
        {/each}
      </div>
    {/if}
    <div class="boutons">
      <button onclick={fermer}>Annuler</button>
      <button class="principal" disabled={!choisi} onclick={() => choisi && autoriser(choisi)}>Autoriser</button>
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
