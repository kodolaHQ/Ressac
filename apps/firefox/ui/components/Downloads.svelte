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

<section class="downloads" data-testid="downloads" aria-label="Téléchargements">
  <header>
    <h1>Téléchargements</h1>
    <button class="close" aria-label="Fermer les téléchargements" onclick={close}><Icon name="close" size={12} /></button>
  </header>
  <ul>
    {#each downloads.list as t (t.id)}
      <li data-testid="download" data-state={t.state}>
        <div class="infos">
          <span class="name">{t.name}</span>
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
      <p class="empty">Aucun téléchargement pendant cette session.</p>
    {/each}
  </ul>
</section>

<style>
  .downloads { height: 100%; overflow-y: auto; box-sizing: border-box; padding: 26px 32px; color: var(--text); }
  header { display: flex; align-items: center; margin-bottom: 18px; }
  h1 { margin: 0; font: 650 26px/1.1 var(--font-display); letter-spacing: -0.02em; }
  .close { margin-left: auto; border: none; background: none; color: var(--text); }
  ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--sheet); box-shadow: var(--lift); overflow: hidden; }
  li { display: flex; align-items: center; gap: 8px; padding: 11px 14px; border-top: 1px solid var(--border); }
  li:first-child { border-top: none; }
  .infos { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { font-size: 12px; color: var(--text-muted); }
  progress { width: 100%; height: 4px; accent-color: var(--accent); }
  li button { padding: 5px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  li button:active { transform: scale(0.97); }
  .empty { margin: 0; padding: 14px; color: var(--text-muted); }
</style>
