<script lang="ts">
  import type { BlocAffiche } from "../../commun/api";

  let { bloc }: { bloc: BlocAffiche } = $props();
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "");
</script>

<article class="bloc" data-testid="bloc-{bloc.id}">
  {#if "erreur" in bloc && !("type" in bloc)}
    <p class="illisible">Bloc « {bloc.id} » illisible : {bloc.erreur}</p>
  {:else if "type" in bloc}
    <header>
      <h2 data-testid="titre-bloc">{bloc.titre}</h2>
      {#if bloc.type === "agent" && bloc.statut === "en-cours"}<span class="badge">mise à jour…</span>{/if}
    </header>
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
  header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
  h2 { margin: 0; font-size: 13px; font-weight: 600; color: var(--texte); }
  .badge { font-size: 11px; color: var(--accent); }
  iframe, webview { display: flex; width: 100%; height: 360px; border: none; background: white; }
  .echec, .illisible, .vide { margin: 0; padding: 8px 12px; font-size: 12px; color: var(--texte-doux); }
  .echec, .illisible { color: #e5736b; }
</style>
