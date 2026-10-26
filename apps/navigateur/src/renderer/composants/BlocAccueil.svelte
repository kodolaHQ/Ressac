<script lang="ts">
  import Icone from "./Icone.svelte";
  import type { BlocAffiche } from "../../commun/api";

  let {
    bloc,
    retirer,
    glisserDebut,
  }: { bloc: BlocAffiche; retirer: () => void; glisserDebut: (e: DragEvent) => void } = $props();
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "");
</script>

<article class="bloc" data-testid="bloc-{bloc.id}">
  <!-- L'en-tête sert de poignée : le contenu (iframe, vue web) avale les événements de la souris. -->
  <header draggable="true" ondragstart={glisserDebut}>
    {#if "type" in bloc}
      <h2 data-testid="titre-bloc">{bloc.titre}</h2>
      {#if bloc.type === "agent" && bloc.statut === "en-cours"}<span class="badge">mise à jour…</span>{/if}
    {:else}
      <p class="illisible">Bloc « {bloc.id} » illisible : {bloc.erreur}</p>
    {/if}
    <button class="retirer" aria-label="Retirer le bloc" title="Retirer le bloc" onclick={retirer}><Icone nom="fermer" taille={12} /></button>
  </header>
  {#if "type" in bloc}
    {#if bloc.type === "agent"}
      {#if bloc.statut === "erreur"}
        <p class="echec">Échec de la mise à jour du {date(bloc.derniereTentative)} : {bloc.erreur ?? "erreur inconnue"}</p>
      {/if}
      {#if bloc.src}
        <!-- Sans allow-scripts ni allow-same-origin : le HTML écrit par l'agent n'exécute rien. -->
        <iframe src={bloc.src} title={bloc.titre} sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>
      {:else}
        <p class="vide">L'agent n'a pas encore écrit ce bloc.</p>
      {/if}
    {:else}
      <webview src={bloc.url} partition="persist:webaios"></webview>
    {/if}
  {/if}
</article>

<style>
  .bloc { display: flex; flex-direction: column; border: 1px solid var(--bord); border-radius: 10px; background: var(--fond-barre); overflow: hidden; }
  header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: grab; }
  h2 { margin: 0; font-size: 13px; font-weight: 600; color: var(--texte); }
  .badge { font-size: 11px; color: var(--accent); }
  .retirer { all: unset; margin-left: auto; width: 20px; height: 20px; display: grid; place-content: center; border-radius: 4px; color: var(--texte-doux); font-size: 11px; cursor: pointer; }
  .retirer:hover { background: var(--fond-survol); }
  iframe, webview { display: flex; width: 100%; height: 360px; border: none; background: white; }
  .echec, .illisible, .vide { margin: 0; padding: 8px 12px; font-size: 12px; color: var(--texte-doux); }
  .illisible { padding: 0; }
  .echec, .illisible { color: #e5736b; }
</style>
