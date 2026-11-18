<script lang="ts">
  import { fade } from "svelte/transition";
  import type { Backup } from "../../shared/settings";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import BrowserImport from "./BrowserImport.svelte";

  // Styles come from Settings.svelte.
  const s = api.settings;
  const dir = s.dataDir();
  /** null: being measured (du over big backups takes seconds). */
  let backups = $state<Backup[] | null>(null);
  /** A backup to delete, or the reset, awaiting confirmation. */
  let asking = $state<{ backup: string } | "reset" | null>(null);
  let exporting = $state(false);
  let importing = $state(false);
  let message = $state<string | null>(null);
  const load = async () => (backups = await s.backups());
  $effect(() => void load());

  const locale = () => appState.value?.locale ?? "fr";
  const date = (iso: string) => new Date(iso).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
  const number = (n: number) => n.toLocaleString(locale(), { maximumFractionDigits: 1 });
  // shortcut: assumes a macOS home under /Users, display only; take the home from the chrome if another OS ships.
  const notes = `${dir}/workspace/.ressac/browsing-notes.md`;
  const shownDir = dir.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
  const size = (b: number) => (b >= 1e9 ? t("agent-size-gb", { n: number(b / 1e9) }) : t("agent-size-mb", { n: number(b / 1e6) }));

  async function deleteBackup(path: string) {
    asking = null;
    const r = await s.deleteBackup(path);
    message = r.ok ? null : r.error;
    await load();
  }
  async function exportData() {
    exporting = true;
    message = null;
    const r = await s.exportData();
    exporting = false;
    message = r.ok ? t("agent-data-exported", { path: r.path }) : r.error;
  }
  async function reset() {
    asking = null;
    if (!(await s.reset())) message = t("agent-data-reset-cancelled");
  }
</script>

<section data-testid="settings-data">
  <h2>{t("settings-section-data")}</h2>
  <div class="panel">
    <div class="row">
      <div class="grow"><b>{t("agent-data-folder")}</b><code class="muted" data-testid="data-dir" title={dir}>{shownDir}</code></div>
      <button data-testid="data-reveal" onclick={() => s.reveal(dir)}>{t("agent-data-reveal")}</button>
    </div>
    <div class="row">
      <div class="grow"><b>{t("agent-data-notes")}</b><span class="muted">{t("agent-data-notes-help")}</span></div>
      <button data-testid="settings-browsing-notes" onclick={() => s.reveal(notes)}>{t("agent-data-reveal")}</button>
    </div>
  </div>
  <h3>{t("agent-data-import-title")}</h3>
  {#if importing}
    <div class="panel import"><BrowserImport /></div>
  {:else}
    <div class="buttons start" out:fade={{ duration: 150 }}><button data-testid="data-import" onclick={() => (importing = true)}>{t("agent-data-import")}</button></div>
  {/if}
  <h3>{t("agent-data-backups")}</h3>
  {#if !backups}
    <p><span class="pill" data-tone="warn">{t("settings-checking")}</span></p>
  {:else}
    <div class="panel">
      {#each backups as b (b.path)}
        <div data-testid="backup-row">
          <div class="row">
            <div class="grow">
              <b>{date(b.date)}</b>
              <span class="muted">{size(b.bytes)}</span>
            </div>
            <button data-testid="backup-reveal" onclick={() => s.reveal(b.path)}>{t("agent-data-reveal")}</button>
            <button class="danger" data-testid="backup-delete" onclick={() => (asking = { backup: b.path })}>{t("agent-data-delete")}</button>
          </div>
          {#if typeof asking === "object" && asking?.backup === b.path}
            {@const path = b.path}
            <div class="confirmation" role="alertdialog" aria-label={t("agent-data-delete-label")}>
              <p>{t("agent-data-delete-confirm")}</p>
              <div class="buttons">
                <button onclick={() => (asking = null)}>{t("agent-cancel")}</button>
                <button class="primary" data-testid="confirm-data" onclick={() => void deleteBackup(path)}>{t("agent-data-delete")}</button>
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="row muted">{t("agent-data-none")}</div>
      {/each}
    </div>
  {/if}
  {#if message}<p role="status">{message}</p>{/if}
  <div class="buttons start">
    <button class="primary" data-testid="data-export" disabled={exporting} onclick={() => void exportData()}>{t("agent-data-export")}</button>
    <button class="danger" data-testid="data-reset" onclick={() => (asking = "reset")}>{t("agent-data-reset")}</button>
  </div>
  {#if asking === "reset"}
    <div class="confirmation" role="alertdialog" aria-label={t("agent-data-reset")}>
      <p>{t("agent-data-reset-confirm")}</p>
      <div class="buttons">
        <button onclick={() => (asking = null)}>{t("agent-cancel")}</button>
        <button class="primary" data-testid="confirm-reset" onclick={() => void reset()}>{t("agent-data-reset-go")}</button>
      </div>
    </div>
  {/if}
</section>

<style>
  .import { padding: 14px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
</style>
