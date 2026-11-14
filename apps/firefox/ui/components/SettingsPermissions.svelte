<script lang="ts">
  import type { GrantRow } from "../../shared/settings";
  import { profileLabel } from "../home-profiles";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";

  // Styles come from Settings.svelte.
  let rows = $state<GrantRow[] | null>(null);
  /** A widget or action grant whose removal awaits confirmation. */
  let asking = $state<GrantRow | null>(null);
  const load = async () => (rows = await api.settings.grants());
  $effect(() => void load());

  async function revoke(r: GrantRow) {
    asking = null;
    await api.settings.revoke(r.kind, r.key);
    await load();
  }

  /** null: not asked; then whether macOS forgot its screen recording grant. */
  let repaired = $state<boolean | null>(null);
</script>

<section data-testid="settings-permissions">
  <h2>{t("settings-section-permissions")}</h2>
  {#if !rows}
    <p><span class="pill" data-tone="warn">{t("settings-checking")}</span></p>
  {:else}
    <div class="panel">
      {#each rows as r (`${r.kind}:${r.key}`)}
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
        <div class="row muted">{t("agent-grants-none")}</div>
      {/each}
    </div>
  {/if}
  <p class="muted">{t("agent-grants-ephemeral")}</p>
  <h2>{t("agent-screen-title")}</h2>
  <div class="panel">
    <div class="row" data-testid="screen-sharing-repair">
      <div class="grow">
        <b>{t("agent-screen-broken")}</b>
        <span class="muted">
          {#if repaired}
            {t("agent-screen-repaired")}
          {:else if repaired === false}
            {t("agent-screen-failed")}
          {:else}
            {t("agent-screen-help")}
          {/if}
        </span>
      </div>
      {#if repaired}
        <span class="pill" data-tone="ok">{t("agent-screen-done")}</span>
      {:else}
        <button data-testid="screen-sharing-repair-button" onclick={async () => (repaired = await api.settings.repairScreenSharing())}>{t("agent-screen-repair")}</button>
      {/if}
    </div>
  </div>
</section>
