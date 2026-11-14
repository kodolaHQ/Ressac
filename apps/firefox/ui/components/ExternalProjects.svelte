<script lang="ts">
  import type { ExternalsState } from "../../shared/api";
  import { api, appState as shell } from "../state.svelte";
  import { t } from "../i18n.svelte";

  let appState = $state<ExternalsState | null>(null);
  let request = 0;
  /** Client name input before the command; null when the form is closed. */
  let name = $state<string | null>(null);
  /** The hookup command, shown once (token included); cleared on close. */
  let command = $state<string | null>(null);
  let error = $state<string | null>(null);
  let copy = $state(false);

  async function load() {
    const n = ++request;
    const r = await api.external.list();
    if (n === request) appState = r;
  }
  $effect(() => {
    void load();
    return api.external.onChange(() => void load());
  });

  async function connect() {
    error = null;
    try {
      const r = await api.external.connect(name ?? "");
      command = r.command;
      name = null;
      copy = false;
    } catch {
      error = t("home-external-failed");
    }
  }
  function closeCommand() {
    command = null;
    copy = false;
  }
  async function copyCommand() {
    if (command === null) return;
    try {
      await navigator.clipboard.writeText(command);
      copy = true;
    } catch {
      copy = false;
    }
  }
  const turnedOff = $derived(appState?.server.state === "off");
</script>

<section class="external" data-testid="external-projects" aria-label={t("home-external-title")}>
  <h2 class="title">{t("home-external-title")}</h2>
  {#if appState}
    {#if appState.server.state === "off"}
      <p class="reason" data-testid="external-reason">{appState.server.reason}</p>
    {/if}
    <ul>
      {#each appState.projects as p (p.id)}
        <li data-testid="external-project">
          <div class="name">
            <b>{p.name}</b>
            <span>{p.folder}</span>
          </div>
          <span class="meta">{t("home-external-ports", { ports: p.ports.join(", ") })}</span>
          <span class="meta">{p.clientName ?? t("home-external-no-client")}</span>
          <div class="actions">
            <button onclick={() => api.external.review(p.id)}>{t("home-external-review")}</button>
            <button onclick={() => void api.external.forget(p.id)}>{t("home-external-forget")}</button>
          </div>
        </li>
      {/each}
      {#each appState.clients as c (c.id)}
        <li data-testid="external-client">
          <div class="name">
            <b>{c.name}</b>
            <span>{t("home-external-connected-on", { date: new Date(c.created).toLocaleDateString(shell.value?.locale ?? "fr") })}</span>
          </div>
          <div class="actions">
            <button onclick={() => void api.external.revoke(c.id)}>{t("home-external-revoke")}</button>
          </div>
        </li>
      {/each}
      {#if appState.projects.length === 0 && appState.clients.length === 0}
        <li class="none">{t("home-external-none")}</li>
      {/if}
    </ul>
  {/if}

  {#if command !== null}
    <div class="command">
      <p>{t("home-external-command")}</p>
      <code data-testid="connect-command">{command}</code>
      <div class="actions">
        <button data-testid="copy-command" onclick={copyCommand}>{copy ? t("home-external-copied") : t("home-external-copy")}</button>
        <button data-testid="close-command" onclick={closeCommand}>{t("home-close")}</button>
      </div>
    </div>
  {:else if name !== null}
    <form
      class="form"
      onsubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
    >
      <label>{t("home-external-client-name")} <input data-testid="connect-name" bind:value={name} placeholder="Claude Code" maxlength="60" /></label>
      <button type="submit" data-testid="confirm-connect">{t("home-external-confirm")}</button>
      <button type="button" onclick={() => (name = null)}>{t("home-cancel")}</button>
    </form>
  {:else}
    <button class="connect" data-testid="connect-external" disabled={turnedOff || appState === null} onclick={() => (name = "Claude Code")}>{t("home-external-connect")}</button>
  {/if}
  {#if error}<p class="reason" role="alert">{error}</p>{/if}
</section>

<style>
  .external { margin-top: 24px; }
  .title { margin: 0 0 10px; font: 650 20px/1.1 var(--font-display); letter-spacing: -0.02em; }
  ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--sheet); box-shadow: var(--lift); overflow: hidden; }
  li { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-top: 1px solid var(--border); }
  li:first-child { border-top: none; }
  li.none { color: var(--text-muted); }
  .name { flex: 1; min-width: 0; }
  .name b { display: block; font-weight: 600; }
  .name span { display: block; font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
  .reason { margin: 0 0 8px; color: var(--text-muted); }
  .actions { display: flex; gap: 6px; flex: none; }
  button { padding: 5px 11px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  button:hover:not(:disabled) { background: var(--bg-active); }
  button:active:not(:disabled) { transform: scale(0.97); }
  button:disabled { opacity: 0.5; }
  .connect { margin-top: 10px; }
  .command, .form { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .form { flex-direction: row; align-items: center; }
  .command p { margin: 0; }
  code { display: block; max-width: 100%; padding: 8px 10px; border-radius: 10px; background: var(--sheet); border: 1px solid var(--border); font: 12px var(--font-mono); user-select: all; overflow-wrap: anywhere; }
  input { padding: 5px 9px; border: 1px solid var(--border); border-radius: 10px; background: var(--glass-hi); color: var(--text); }
</style>
