<script lang="ts">
  import type { GrantRow } from "../../shared/settings";
  import { profileLabel } from "../home-profiles";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  // Styles come from Settings.svelte.
  const s = api.settings;
  let rows = $state<GrantRow[] | null>(null);
  /** A widget or action grant whose removal awaits confirmation. */
  let asking = $state<GrantRow | null>(null);
  const load = async () => (rows = await s.grants());
  /** The search field shows past this many rows; it matches the site's name and the access it has. */
  const SEARCH_FROM = 6;
  let query = $state("");
  const shown = $derived.by(() => {
    const q = query.trim().toLocaleLowerCase();
    return !rows || !q ? rows : rows.filter((r) => `${r.name} ${r.detail}`.toLocaleLowerCase().includes(q));
  });
  $effect(() => void load());

  async function revoke(r: GrantRow) {
    asking = null;
    await s.revoke(r.kind, r.key);
    await load();
  }

  /** null: not asked; then whether macOS forgot its screen recording grant. */
  let repaired = $state<boolean | null>(null);
  let telemetry = $state<{ available: boolean; enabled: boolean; crashReports: boolean } | null>(null);
  // Copied: an object from the chrome's realm is not made reactive, and the crash switch follows `enabled`.
  $effect(() => void s.telemetry().then((t) => (telemetry = { ...t })));
</script>

<section data-testid="settings-privacy" aria-label={t("settings-section-privacy")}>
  <div class="group-head">
    <h3 class="group-title">{t("settings-group-permissions")}</h3>
    {#if rows && rows.length >= SEARCH_FROM}
      <input class="search appear" type="search" data-testid="permissions-search" placeholder={t("settings-permissions-search")} aria-label={t("settings-permissions-search")} bind:value={query} spellcheck="false" />
    {/if}
  </div>
  {#if !rows}
    <p class="status"><span class="pill" data-tone="warn">{t("settings-checking")}</span></p>
  {:else}
    <div class="group" data-testid="settings-permissions">
      {#each shown ?? [] as r (`${r.kind}:${r.key}`)}
        <div data-testid="grant-row" data-kind={r.kind}>
          <div class="row">
            <div class="grow">
              <b>{r.name}</b>
              <span class="muted">{r.detail}</span>
              {#if r.profile && appState.value}<span class="muted">{profileLabel(appState.value, r.profile, t)}</span>{/if}
            </div>
            <button class="danger" data-testid="grant-revoke" onclick={() => (r.kind === "widget" || r.kind === "action" ? (asking = r) : void revoke(r))}>{t("agent-grants-revoke")}</button>
          </div>
          {#if asking?.kind === r.kind && asking.key === r.key}
            <div class="confirmation" role="alertdialog" aria-label={t("agent-grants-revoke")}>
              <p>{t("agent-grants-confirm")}</p>
              <div class="buttons">
                <button onclick={() => (asking = null)}>{t("agent-cancel")}</button>
                <button class="primary" data-testid="confirm-grant" onclick={() => void revoke(r)}>{t("agent-grants-revoke")}</button>
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="row muted" data-testid={rows.length ? "permissions-no-match" : undefined}>{t(rows.length ? "settings-permissions-no-match" : "agent-grants-none")}</div>
      {/each}
    </div>
  {/if}
  <p class="caption">{t("agent-grants-ephemeral")}</p>

  <div class="group">
    <SettingsRow label={t("agent-screen-title")} testid="screen-sharing-repair">
      {#if repaired}
        <span class="pill" data-tone="ok">{t("agent-screen-done")}</span>
      {:else}
        <button data-testid="screen-sharing-repair-button" onclick={async () => (repaired = await s.repairScreenSharing())}>{t("agent-screen-repair")}</button>
      {/if}
      {#snippet below()}
        <span class="help">{t("agent-screen-broken")} {#if repaired}{t("agent-screen-repaired")}{:else if repaired === false}{t("agent-screen-failed")}{:else}{t("agent-screen-help")}{/if}</span>
      {/snippet}
    </SettingsRow>
    {#if !telemetry}
      <SettingsRow label={t("settings-telemetry-label")}><span class="pill" data-tone="warn">{t("settings-checking")}</span></SettingsRow>
    {:else}
      <SettingsRow label={t("settings-telemetry-label")} id="telemetry-switch" help={t("agent-telemetry-notice")}>
        <input
          id="telemetry-switch"
          class="switch"
          type="checkbox"
          role="switch"
          data-testid="telemetry-switch"
          aria-describedby="telemetry-switch-help"
          disabled={!telemetry.available}
          checked={telemetry.enabled}
          onchange={(e) => {
            telemetry!.enabled = e.currentTarget.checked;
            s.setTelemetry(telemetry!.enabled);
          }}
        />
        {#snippet below()}
          {#if !telemetry?.available}<span class="help">{t("settings-telemetry-unavailable")}</span>{/if}
        {/snippet}
      </SettingsRow>
      <SettingsRow label={t("settings-crash-reports-label")} id="crash-reports-switch" help={t("settings-crash-reports-help")}>
        <input
          id="crash-reports-switch"
          class="switch"
          type="checkbox"
          role="switch"
          data-testid="crash-reports-switch"
          aria-describedby="crash-reports-switch-help"
          disabled={!telemetry.available || !telemetry.enabled}
          checked={telemetry.crashReports}
          onchange={(e) => {
            telemetry!.crashReports = e.currentTarget.checked;
            s.setCrashReports(telemetry!.crashReports);
          }}
        />
      </SettingsRow>
    {/if}
  </div>
</section>

<style>
  .search { width: 220px; min-height: 28px; }
</style>
