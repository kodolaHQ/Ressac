<script lang="ts">
  import type { ExtensionLine } from "../../shared/extensions";
  import { DISABLED_CRASHES, DISABLED_SCOPE } from "../../shared/extensions-messages";
  import type { ExtensionResult } from "../../shared/api";
  import { fade } from "svelte/transition";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import { markSeen } from "./hints";
  import { showSection } from "./Settings.svelte";

  // Everything from a manifest or a console is shown as text (never {@html}): it is data.
  let lines = $state<ExtensionLine[]>([]);
  let cuts = $state(false);
  let chargee = $state(false);
  let reopened = $state(false);
  let accountSaved = $state(false);
  // Closed = « extensions » is in the hints' seen list (kept by the session); the link shows the block again without resetting it.
  const helpShown = $derived(reopened || !appState.value?.settings.hints.seen.includes("extensions"));
  $effect(() => void api.settings.amoAccount().then((a) => (accountSaved = a.saved)));
  function connect() {
    showSection("agent");
    api.dispatch({ type: "openSettings", windowId: api.windowId });
  }
  function closeHelp() {
    reopened = false;
    markSeen("extensions");
  }
  let message = $state<string | null>(null);
  let details = $state<Record<string, boolean>>({});
  /** Extension whose deletion awaits the user's confirmation. */
  let toDelete = $state<ExtensionLine | null>(null);
  let request = 0;

  async function load() {
    const n = ++request;
    const [l, b] = await Promise.all([api.extensions.list(), api.extensions.allCut()]);
    if (n !== request) return;
    lines = l;
    cuts = b;
    chargee = true;
  }

  $effect(() => {
    void load();
    return api.extensions.onChange(() => void load());
  });

  async function make(p: Promise<ExtensionResult>) {
    message = null;
    const r = await p;
    if (!r.ok) message = r.error;
    await load();
  }

  const date = (iso: string) => new Date(iso).toLocaleString(appState.value?.locale ?? "fr", { dateStyle: "medium", timeStyle: "short" });
  const spaces = (l: ExtensionLine) =>
    l.spaces.length ? l.spaces.map((e) => t("home-extensions-space-item", { name: e.name, profile: e.profile })).join(", ") : l.siteApps.length ? t("home-extensions-none") : t("home-extensions-nowhere");
  const list = (items: string[], sep: string, none: string) => (items.length ? items.join(sep) : none);
  /** The host sends its two deactivation messages as French sentinels; the page shows them in the current language. */
  const disabledText = (d: string) => (d === DISABLED_CRASHES ? t("home-extensions-disabled-crashes") : d === DISABLED_SCOPE ? t("home-extensions-disabled-scope") : d);
</script>

<section class="extensions" data-testid="page-extensions" aria-label={t("home-extensions-title")}>
  <header>
    <h1>{t("home-extensions-title")}</h1>
    <label class="cutoff">
      <input
        type="checkbox"
        role="switch"
        data-testid="extensions-off"
        checked={cuts}
        onchange={(e) => void make(api.extensions.cutAll(e.currentTarget.checked))}
      />
      {t("home-extensions-cut-all")}
    </label>
  </header>
  {#if helpShown}
    <div class="help" data-testid="extensions-help" out:fade={{ duration: 150 }}>
      <div class="help-head">
        <h2>{t("home-extensions-help")}</h2>
        <button data-testid="extensions-help-close" onclick={closeHelp}>{t("home-close")}</button>
      </div>
      <ol>
        <li>
          <b>{t("home-extensions-step1")}</b>{t("home-extensions-step1-text")}
          {#if accountSaved}<span class="ok">{t("home-extensions-connected")}</span>{:else}<button class="primary" data-testid="extensions-connect" onclick={connect}>{t("home-extensions-connect")}</button>{/if}
        </li>
        <li><b>{t("home-extensions-step2")}</b>{t("home-extensions-step2-text")}</li>
        <li><b>{t("home-extensions-step3")}</b>{t("home-extensions-step3-text")}</li>
      </ol>
      <p class="muted">{t("home-extensions-help-note")}</p>
    </div>
  {:else}
    <button class="link" data-testid="extensions-help-link" onclick={() => (reopened = true)}>{t("home-extensions-help")}</button>
  {/if}
  {#if message}<p class="message" role="status" data-testid="message-extensions">{message}</p>{/if}
  {#if cuts}<p class="banner" role="status">{t("home-extensions-all-cut")}</p>{/if}
  {#if chargee && lines.length === 0}
    <p class="empty">{t("home-extensions-empty")}</p>
  {/if}
  <ul>
    {#each lines as l (l.key)}
      <li data-testid="extension-page" data-key={l.key}>
        <div class="head">
          <b>{l.name}</b>
          <span class="muted">{l.source === "store" ? "addons.mozilla.org" : t("home-by-agent")} · {l.version}</span>
        </div>
        {#if l.disabled}<p class="alert">{disabledText(l.disabled)}</p>{/if}
        {#if l.consoleUnlocked}<p class="alert" data-testid="console-unlocked">{t("home-extensions-console-unlocked")}</p>{/if}
        {#if l.pendingUpdate}<p class="muted">{t("home-extensions-pending-update", { version: l.pendingUpdate })}</p>{/if}
        <p>{t("home-extensions-rights", { list: list(l.rights, " · ", t("home-extensions-none")) })}</p>
        <p>{t("home-extensions-sites", { list: l.allSites ? t("home-extensions-all-sites") : list(l.sites, ", ", t("home-extensions-none")) })}</p>
        <p>{t("home-extensions-spaces", { list: spaces(l) })}</p>
        {#if l.siteApps.length}<p data-testid="extension-apps">{t("home-extensions-active-in", { names: l.siteApps.join(", ") })}</p>{/if}
        {#if l.modifiedAt}<p class="muted">{t("home-extensions-modified", { date: date(l.modifiedAt) })}</p>{/if}
        {#if l.unsupported.length}<p class="muted">{t("home-extensions-unsupported", { list: l.unsupported.join(", ") })}</p>{/if}
        {#if l.errors.length}
          <p class="alert">{t("home-extensions-errors", { list: details[l.key] ? l.errors.join(" ; ") : l.errors[l.errors.length - 1]! })}</p>
        {/if}
        {#if details[l.key]}
          <dl class="details" data-testid="extension-details">
            <dt>{t("home-extensions-key")}</dt>
            <dd>{l.key}</dd>
            <dt>{t("home-extensions-label-rights")}</dt>
            <dd>{#each l.rights as d (d)}<span>{d}</span>{:else}{t("home-extensions-none")}{/each}</dd>
            <dt>{t("home-extensions-label-sites")}</dt>
            <dd>{#each l.sites as s (s)}<span>{s}</span>{:else}{t("home-extensions-none")}{/each}</dd>
            <dt>{t("home-extensions-label-errors")}</dt>
            <dd>{#each l.errors as e, i (i)}<span>{e}</span>{:else}{t("home-extensions-none-f")}{/each}</dd>
          </dl>
        {/if}
        <div class="actions">
          {#if l.pendingUpdate}<button onclick={() => void make(api.extensions.review(l.key))}>{t("home-extensions-review-update")}</button>{/if}
          {#if l.source === "agent" && l.disabled === DISABLED_SCOPE}
            <button onclick={() => void make(api.extensions.review(l.key))}>{t("home-extensions-review-grant")}</button>
          {/if}
          {#if l.disabled === DISABLED_CRASHES}<button onclick={() => void make(api.extensions.reenable(l.key))}>{t("home-extensions-reenable")}</button>{/if}
          {#if l.consoleUnlocked}<button onclick={() => void make(api.extensions.cutUnlock(l.key))}>{t("home-extensions-cut-unlock")}</button>{/if}
          <button disabled={l.spaces.length === 0 && l.siteApps.length === 0} onclick={() => void make(api.extensions.disableEverywhere(l.key))}>{t("home-extensions-disable-everywhere")}</button>
          <button onclick={() => (toDelete = l)}>{t("home-delete")}</button>
          <button aria-expanded={!!details[l.key]} onclick={() => (details[l.key] = !details[l.key])}>{t("home-extensions-details")}</button>
        </div>
      </li>
    {/each}
  </ul>
</section>
{#if toDelete}
  {@const target = toDelete}
  <div class="veil">
    <div class="confirmation" role="alertdialog" aria-modal="true" data-testid="extension-delete-confirmation">
      <p>
        {t(target.source === "store" ? "home-extensions-delete-store" : "home-extensions-delete-agent", { name: target.name })}
      </p>
      <div class="buttons">
        <button onclick={() => (toDelete = null)}>{t("home-cancel")}</button>
        <button
          class="confirm"
          onclick={() => {
            const key = target.key; // {@const} is re-read: after toDelete = null, cible is null
            toDelete = null;
            void make(api.extensions.remove(key));
          }}>{t("home-delete")}</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .extensions { height: 100%; overflow-y: auto; padding: 26px 32px; box-sizing: border-box; color: var(--text); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
  h1 { margin: 0; font: 650 26px/1.1 var(--font-display); letter-spacing: -0.02em; }
  .cutoff { display: flex; align-items: center; gap: 8px; }
  .help { margin-bottom: 14px; padding: 14px 16px; border-radius: 16px; border: 1px solid var(--glass-edge); background: var(--glass-dense, var(--glass)); box-shadow: var(--lift); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .help-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .help h2 { margin: 0; font: 650 17px/1.2 var(--font-display); }
  .help ol { margin: 10px 0; padding-left: 20px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
  .help p { margin: 0; font-size: 12px; }
  .ok { color: var(--ok, var(--text-muted)); font-weight: 600; }
  .primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); margin-left: 6px; }
  .link { margin-bottom: 14px; border: none; background: none; color: var(--accent); padding: 0; }
  button { padding: 5px 11px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; }
  .message, .banner { margin: 0 0 14px; padding: 10px 14px; border-radius: 12px; background: var(--glass-hi); border: 1px solid var(--border); }
  .empty, .muted { color: var(--text-muted); }
  ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--sheet); box-shadow: var(--lift); overflow: hidden; }
  li { padding: 12px 14px; border-top: 1px solid var(--border); }
  li:first-child { border-top: none; }
  ul:not(:has(li)) { display: none; }
  li p { margin: 4px 0; font-size: 13px; overflow-wrap: anywhere; }
  .head { display: flex; align-items: baseline; gap: 10px; }
  .head .muted { font-size: 12px; }
  .alert { color: var(--in-error); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .details { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 8px 0; font-size: 12px; }
  .details dt { color: var(--text-muted); }
  .details dd { margin: 0; display: flex; flex-direction: column; overflow-wrap: anywhere; }
  .veil { position: fixed; inset: 0; display: grid; place-content: center; background: var(--veil); backdrop-filter: blur(6px); z-index: 10; }
  .confirmation { max-width: 420px; padding: 18px 20px; border-radius: 16px; background: var(--glass-dense); border: 1px solid var(--glass-edge); box-shadow: var(--modal-shadow); color: var(--text); animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  .confirmation p { margin: 0 0 14px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  .buttons .confirm { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
</style>
