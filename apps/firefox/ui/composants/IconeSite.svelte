<script lang="ts">
  import { urlIcone } from "../../shared/icone";

  let { favicon, titre, taille = 16 }: { favicon: string | null; titre: string; taille?: number } = $props();
  let erreur = $state(false);
  // The UI has no network: an http(s) favicon goes through webaios-icone: (shared/icone.ts).
  const source = $derived(favicon ? urlIcone(favicon) : null);
</script>

{#if source && !erreur}
  <img src={source} alt="" width={taille} height={taille} onerror={() => (erreur = true)} />
{:else}
  <span class="lettre" style:width="{taille}px" style:height="{taille}px" style:font-size="{taille * 0.6}px">{(titre.replace(/^https?:\/\/(www\.)?/, "")[0] ?? "?").toUpperCase()}</span>
{/if}

<style>
  img { border-radius: 3px; flex: none; }
  .lettre { display: inline-grid; place-content: center; flex: none; border-radius: 3px; background: var(--fond-actif); color: var(--texte-doux); }
</style>
