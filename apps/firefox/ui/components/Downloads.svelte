<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { Download } from "../../shared/model";
  import { api, appState, downloads } from "../state.svelte";
  import { t } from "../i18n.svelte";

  let { close }: { close: () => void } = $props();

  function size(bytes: number): string {
    const number = (n: number, digits: number) => new Intl.NumberFormat(appState.value?.locale ?? "fr", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
    if (bytes < 1024) return t("sidebar-size-b", { n: bytes });
    if (bytes < 1024 ** 2) return t("sidebar-size-kb", { n: number(bytes / 1024, 0) });
    if (bytes < 1024 ** 3) return t("sidebar-size-mb", { n: number(bytes / 1024 ** 2, 1) });
    return t("sidebar-size-gb", { n: number(bytes / 1024 ** 3, 2) });
  }

  const LABELS: Record<Download["state"], string> = {
    "in-progress": "sidebar-download-in-progress",
    done: "sidebar-download-done",
    canceled: "sidebar-download-canceled",
    interrupted: "sidebar-download-interrupted",
  };
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && close()} />

<section class="downloads" data-testid="downloads" aria-label={t("sidebar-downloads")}>
  <header>
    <h1>{t("sidebar-downloads")}</h1>
    <button class="close" aria-label={t("sidebar-downloads-close")} onclick={close}><Icon name="close" size={12} /></button>
  </header>
  <ul>
    {#each downloads.list as dl (dl.id)}
      <li data-testid="download" data-state={dl.state}>
        <div class="infos">
          <span class="name">{dl.name}</span>
          <span class="detail">
            {t(LABELS[dl.state])} · {dl.state === "in-progress" && dl.total ? t("sidebar-download-of", { received: size(dl.received), total: size(dl.total) }) : size(dl.received)}
          </span>
          {#if dl.state === "in-progress"}
            <progress max={dl.total || undefined} value={dl.total ? dl.received : undefined}></progress>
          {/if}
        </div>
        {#if dl.state === "done"}<button onclick={() => api.downloads.open(dl.id)}>{t("sidebar-download-open")}</button>{/if}
        {#if dl.state === "in-progress"}<button onclick={() => api.downloads.cancel(dl.id)}>{t("sidebar-cancel")}</button>{/if}
        <button onclick={() => api.downloads.show(dl.id)}>{t("sidebar-download-show")}</button>
      </li>
    {:else}
      <p class="empty">{t("sidebar-download-none")}</p>
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
