<script lang="ts">
  import { fade } from "svelte/transition";
  import type { Backup } from "../../shared/settings";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import BrowserImport from "./BrowserImport.svelte";
  import SettingsRow from "./SettingsRow.svelte";

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

<section data-testid="settings-data" aria-label={t("settings-section-data")}>
  <div class="group">
    <SettingsRow label={t("agent-data-folder")}>
      <code class="path" data-testid="data-dir" title={dir}>{shownDir}</code>
      <button data-testid="data-reveal" onclick={() => s.reveal(dir)}>{t("agent-data-reveal")}</button>
    </SettingsRow>
    <SettingsRow label={t("agent-data-notes")} help={t("agent-data-notes-help")}>
      <button data-testid="settings-browsing-notes" onclick={() => s.reveal(notes)}>{t("agent-data-reveal")}</button>
    </SettingsRow>
    {#if importing}
      <div class="import"><BrowserImport /></div>
    {:else}
      <div out:fade={{ duration: 150 }}>
        <SettingsRow label={t("agent-data-import-title")}>
          <button data-testid="data-import" onclick={() => (importing = true)}>{t("agent-data-import")}</button>
        </SettingsRow>
      </div>
    {/if}
  </div>

  <div class="group-head">
    <h3 class="group-title">{t("agent-data-backups")}</h3>
    <button data-testid="data-export" disabled={exporting} onclick={() => void exportData()}>{t("agent-data-export")}</button>
  </div>
  {#if message}<p class="caption appear" role="status">{message}</p>{/if}
  {#if !backups}
    <p class="status"><span class="pill" data-tone="warn">{t("settings-checking")}</span></p>
  {:else}
    <div class="group">
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

  <h3 class="group-title">{t("settings-danger")}</h3>
  <div class="group danger-zone">
    <SettingsRow label={t("settings-data-reset-label")} help={t("settings-data-reset-help")}>
      <button class="danger" data-testid="data-reset" onclick={() => (asking = "reset")}>{t("agent-data-reset")}</button>
      {#snippet below()}
        {#if asking === "reset"}
          <div class="confirmation" role="alertdialog" aria-label={t("agent-data-reset")} out:fade={{ duration: 150 }}>
            <p>{t("agent-data-reset-confirm")}</p>
            <div class="buttons">
              <button onclick={() => (asking = null)}>{t("agent-cancel")}</button>
              <button class="primary" data-testid="confirm-reset" onclick={() => void reset()}>{t("agent-data-reset-go")}</button>
            </div>
          </div>
        {/if}
      {/snippet}
    </SettingsRow>
  </div>
</section>

<style>
  .import { padding: 16px 18px; animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .path { color: var(--text-muted); }
</style>
