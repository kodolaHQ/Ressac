<script lang="ts">
  import { api } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  const s = api.settings;
  let saved = $state(false);
  let issuer = $state<string | null>(null);
  let typedIssuer = $state("");
  let secret = $state("");
  let error = $state<string | null>(null);
  $effect(() => void s.amoAccount().then((a) => ((saved = a.saved), (issuer = a.issuer))));

  async function save() {
    const typed = typedIssuer.trim();
    const r = await s.setAmoAccount(typed, secret.trim());
    secret = "";
    error = r.ok ? null : r.error;
    if (r.ok) ((saved = true), (issuer = typed), (typedIssuer = ""));
  }
  async function remove() {
    const r = await s.deleteAmoAccount();
    error = r.ok ? null : r.error;
    if (r.ok) ((saved = false), (issuer = null));
  }
</script>

<div data-testid="mozilla-account">
<h3 class="group-title">{t("agent-mozilla-title")}</h3>
<div class="group">
  <SettingsRow label={t("settings-agent-account")} help={t("agent-mozilla-help")}>
    <span class="pill" data-tone={saved ? "ok" : "warn"} data-testid="mozilla-state">{saved ? t("agent-mozilla-on") : t("agent-mozilla-off")}</span>
    {#if saved}<code class="muted" data-testid="mozilla-issuer">{issuer}</code>{/if}
    {#if saved}<button data-testid="mozilla-delete" onclick={() => void remove()}>{t("agent-mozilla-remove")}</button>{/if}
    {#snippet below()}
      {#if !saved}
        <div class="form appear">
          <span class="help">
            <a href="https://addons.mozilla.org/developers/addon/api/key/" data-testid="mozilla-link" onclick={(e) => (e.preventDefault(), s.openUrl(e.currentTarget.href))}>{t("agent-mozilla-link")}</a>
            {t("agent-mozilla-steps")}
          </span>
          <label class="field"><span>{t("agent-mozilla-issuer")}</span><input data-testid="mozilla-issuer-input" bind:value={typedIssuer} placeholder="user:12345:678" autocomplete="off" spellcheck="false" /></label>
          <label class="field"><span>{t("agent-mozilla-secret")}</span><input data-testid="mozilla-secret-input" type="password" bind:value={secret} autocomplete="off" spellcheck="false" /></label>
          <div><button class="primary" data-testid="mozilla-save" disabled={!typedIssuer.trim() || !secret.trim()} onclick={() => void save()}>{t("agent-mozilla-save")}</button></div>
        </div>
      {/if}
      {#if error}<span class="alert appear" role="status">{error}</span>{/if}
    {/snippet}
  </SettingsRow>
</div>
</div>

<style>
  .form { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); max-width: 360px; }
  a { color: var(--accent); }
</style>
