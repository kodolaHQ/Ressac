<script lang="ts">
  import type { EtatFenetre } from "../../commun/modele";
  import { api, etat } from "../etat.svelte";

  let { fenetre }: { fenetre: EtatFenetre } = $props();
  const onglet = $derived.by(() => {
    const id = fenetre.actif[fenetre.espaceActif];
    return id ? etat.valeur?.onglets[id] : undefined;
  });
  let saisie = $state<string | null>(null); // non nul pendant l'édition
  let champ: HTMLInputElement;

  function hote(url: string): string {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : url;
    } catch {
      return url;
    }
  }

  function valider(e: SubmitEvent) {
    e.preventDefault();
    const texte = saisie?.trim();
    if (texte) api.naviguer(onglet?.id ?? null, texte);
    saisie = null;
    champ.blur();
  }
</script>

<div class="navigation">
  <button aria-label="Reculer" disabled={!onglet?.peutReculer} onclick={() => onglet && api.commande(onglet.id, "reculer")}>←</button>
  <button aria-label="Avancer" disabled={!onglet?.peutAvancer} onclick={() => onglet && api.commande(onglet.id, "avancer")}>→</button>
  {#if onglet?.chargement}
    <button aria-label="Arrêter" onclick={() => api.commande(onglet.id, "arreter")}>✕</button>
  {:else}
    <button aria-label="Recharger" disabled={!onglet} onclick={() => onglet && api.commande(onglet.id, "recharger")}>⟳</button>
  {/if}
  <button class="compact" aria-label="Mode compact" title="Mode compact (⌘⇧S)" onclick={() => api.agir({ type: "basculerCompact", fenetreId: fenetre.id })}>◧</button>
</div>
<form onsubmit={valider}>
  <input
    bind:this={champ}
    data-testid="barre-adresse"
    value={saisie ?? (onglet ? hote(onglet.url) : "")}
    placeholder="Rechercher ou saisir une adresse"
    spellcheck="false"
    oninput={(e) => (saisie = e.currentTarget.value)}
    onfocus={(e) => {
      saisie = onglet?.url ?? "";
      const el = e.currentTarget;
      requestAnimationFrame(() => el.select());
    }}
    onblur={() => (saisie = null)}
    onkeydown={(e) => e.key === "Escape" && champ.blur()}
  />
</form>

<style>
  .navigation { display: flex; gap: 2px; padding: 0 2px 6px 70px; -webkit-app-region: drag; }
  .navigation button { all: unset; width: 26px; height: 24px; display: grid; place-content: center; border-radius: 5px; color: var(--texte-doux); -webkit-app-region: no-drag; }
  .navigation button:hover:not(:disabled) { background: var(--fond-survol); color: var(--texte); }
  .navigation button:disabled { opacity: 0.35; }
  .navigation .compact { margin-left: auto; }
  input { width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 8px; border: 1px solid transparent; background: var(--fond-survol); color: var(--texte); outline: none; -webkit-app-region: no-drag; }
  input:focus { border-color: var(--accent); background: var(--fond); }
</style>
