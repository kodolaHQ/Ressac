<script lang="ts">
  import type { EtatIaAffiche } from "../../commun/api";
  import { api } from "../etat.svelte";

  const LIGNES_MAX = 200;

  let etat = $state<EtatIaAffiche | null>(null);
  let confirmation = $state(false);
  /** null : aucune installation affichée ; sinon ses lignes, son issue quand elle est finie. */
  let installation = $state<{ lignes: string[]; fini: boolean; erreur?: string } | null>(null);

  const relire = () => api.ia.etat().then((e) => (etat = e), () => {});
  $effect(() => {
    relire();
    const sansEtat = api.ia.surEtat((e) => (etat = e));
    const sansProgres = api.ia.surProgres((ligne) => {
      if (!installation || installation.fini) return;
      installation.lignes = [...installation.lignes, ligne].slice(-LIGNES_MAX);
    });
    return () => (sansEtat(), sansProgres());
  });

  const libelle = $derived.by(() => {
    switch (etat?.etat) {
      case "arretee": return "arrêtée";
      case "demarrage": return "démarre…";
      case "active": return "active";
      case "erreur": return `erreur : ${etat.erreur ?? "inconnue"}`;
      case "non-installee": return "non installée";
      default: return "…";
    }
  });

  // Seul chemin vers le téléchargement : le bouton de la confirmation, cliqué par l'utilisateur.
  async function installer() {
    confirmation = false;
    installation = { lignes: [], fini: false };
    let issue: { ok: boolean; erreur?: string };
    try {
      issue = await api.ia.installer();
    } catch (e) {
      issue = { ok: false, erreur: e instanceof Error ? e.message : String(e) };
    }
    installation = { lignes: installation?.lignes ?? [], fini: true, erreur: issue.ok ? undefined : (issue.erreur ?? "échec de l'installation") };
    relire();
  }
</script>

<div class="ia" data-testid="ia-locale" class:erreur={etat?.etat === "erreur"} title={etat?.etat === "erreur" ? etat.erreur : undefined}>
  <span class="pastille" data-etat={etat?.etat}></span>
  <span class="texte">IA locale : {libelle}</span>
  {#if etat?.etat === "non-installee" && !installation}
    <button data-testid="installer-ia" onclick={() => (confirmation = true)}>Installer…</button>
  {/if}
</div>

{#if confirmation}
  <div class="voile">
    <div class="carte" role="alertdialog" aria-modal="true" data-testid="confirmation-installer-ia">
      <p>Télécharger Kev-4B (environ 8 Go) et Gemma 4 E4B (environ 10 Go) ?</p>
      <div class="boutons">
        <button onclick={() => (confirmation = false)}>Annuler</button>
        <button class="principal" onclick={installer}>Télécharger</button>
      </div>
    </div>
  </div>
{/if}

{#if installation}
  <div class="voile">
    <div class="carte large" role="dialog" aria-modal="true" data-testid="installation-ia">
      <p>
        {#if !installation.fini}Installation de l'IA locale…
        {:else if installation.erreur}<span class="echec">Installation échouée : {installation.erreur}</span>
        {:else}IA locale installée.{/if}
      </p>
      <pre>{installation.lignes.join("\n")}</pre>
      {#if installation.fini}
        <div class="boutons"><button class="principal" onclick={() => (installation = null)}>Fermer</button></div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .ia { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--bord); background: var(--fond-barre); font-size: 12px; color: var(--texte-doux); max-width: 340px; }
  .texte { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pastille { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--arretee); }
  .pastille[data-etat="active"] { background: var(--en-marche); }
  .pastille[data-etat="demarrage"] { background: var(--en-cours); }
  .pastille[data-etat="erreur"] { background: var(--en-erreur); }
  .ia.erreur .texte, .echec { color: var(--en-erreur); }
  .ia button { padding: 2px 8px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: white; font-size: 12px; cursor: pointer; }
  .voile { position: fixed; inset: 0; display: grid; place-content: center; background: var(--voile); z-index: 10; }
  .carte { width: min(420px, 90vw); padding: 16px 20px; border-radius: 10px; background: var(--fond-barre); border: 1px solid var(--bord); color: var(--texte); box-shadow: var(--ombre-modale); }
  .carte.large { width: min(640px, 90vw); }
  .carte p { margin: 0 0 14px; }
  pre { max-height: 50vh; overflow: auto; margin: 0 0 14px; padding: 8px; border-radius: 6px; background: var(--fond); font-size: 11px; white-space: pre-wrap; word-break: break-all; }
  pre:empty { display: none; }
  .boutons { display: flex; justify-content: flex-end; gap: 8px; }
  .boutons button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); }
  .boutons .principal { background: var(--accent); border-color: var(--accent); color: white; }
</style>
