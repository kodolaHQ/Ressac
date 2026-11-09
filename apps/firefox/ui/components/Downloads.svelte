<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { Download } from "../../shared/model";
  import { api, downloads } from "../state.svelte";

  let { close: close }: { close: () => void } = $props();

  function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} Ko`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
    return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
  }

  const LABELS: Record<Download["state"], string> = {
    "in-progress": "En cours",
    done: "Terminé",
    canceled: "Annulé",
    interrupted: "Interrompu",
  };
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && close()} />

<section class="telechargements" data-testid="telechargements" aria-label="Téléchargements">
  <header>
    <h1>Téléchargements</h1>
    <button class="fermer" aria-label="Fermer les téléchargements" onclick={close}><Icon name="close" size={12} /></button>
  </header>
  <ul>
    {#each downloads.list as t (t.id)}
      <li data-testid="telechargement" data-etat={t.state}>
        <div class="infos">
          <span class="nom">{t.name}</span>
          <span class="detail">
            {LABELS[t.state]} · {t.state === "in-progress" && t.total ? `${size(t.received)} sur ${size(t.total)}` : size(t.received)}
          </span>
          {#if t.state === "in-progress"}
            <progress max={t.total || undefined} value={t.total ? t.received : undefined}></progress>
          {/if}
        </div>
        {#if t.state === "done"}<button onclick={() => api.downloads.open(t.id)}>Ouvrir</button>{/if}
        {#if t.state === "in-progress"}<button onclick={() => api.downloads.cancel(t.id)}>Annuler</button>{/if}
        <button onclick={() => api.downloads.show(t.id)}>Afficher dans le Finder</button>
      </li>
    {:else}
      <p class="vide">Aucun téléchargement pendant cette session.</p>
    {/each}
  </ul>
</section>

<style>
  .telechargements { height: 100%; overflow-y: auto; box-sizing: border-box; padding: 24px 32px; color: var(--texte); }
  header { display: flex; align-items: center; margin-bottom: 12px; }
  h1 { font-size: 18px; margin: 0; }
  .fermer { margin-left: auto; border: none; background: none; color: var(--texte); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 8px; padding: 10px 8px; border-bottom: 1px solid var(--bord); }
  .infos { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .nom { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { font-size: 12px; color: var(--texte-doux); }
  progress { width: 100%; height: 4px; accent-color: var(--accent); }
  li button { padding: 4px 8px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); }
  .vide { color: var(--texte-doux); }
</style>
