<script lang="ts">
  import ExtensionsBar from "../ExtensionsStrip.svelte";
  import DesignButton from "./DesignButton.svelte";
  import HideButton from "./HideButton.svelte";
  import AccessBadge from "./AccessBadge.svelte";
  import Icon from "./Icon.svelte";
  import { fade } from "svelte/transition";
  import { shownConnection } from "../../core/url";
  import type { WindowState, Visit } from "../../shared/model";
  import { shortcutLabel } from "../../shared/shortcuts";
  import { accessOf, api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";

  let { window: win }: { window: WindowState } = $props();
  const tab = $derived.by(() => {
    const id = win.active[win.activeSpace];
    return id ? appState.value?.tabs[id] : undefined;
  });
  const agentRights = $derived(tab ? accessOf(tab.id) : undefined);
  const connection = $derived(tab ? shownConnection(tab) : null);
  let input = $state<string | null>(null); // non-null during editing
  let field: HTMLInputElement;
  let suggestions = $state<Visit[]>([]);
  let chosen = $state(-1);
  let request = 0;

  async function suggest(text: string) {
    const n = ++request;
    const r = text.trim() ? await api.history.search(text.trim(), 6, true) : [];
    if (n === request && input !== null) {
      suggestions = r;
      chosen = -1;
    }
  }

  function closeSuggestions() {
    request++;
    suggestions = [];
    chosen = -1;
  }

  function go(text: string) {
    api.navigate(tab?.id ?? null, text);
    input = null;
    closeSuggestions();
    field.blur();
  }

  function clavier(e: KeyboardEvent) {
    if (e.key === "Escape") field.blur();
    else if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      chosen = (chosen + 1) % suggestions.length;
    } else if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      chosen = chosen <= 0 ? suggestions.length - 1 : chosen - 1;
    }
  }

  function hostName(url: string): string {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : url;
    } catch {
      return url;
    }
  }

  function validate(e: SubmitEvent) {
    e.preventDefault();
    const suggestion = suggestions[chosen];
    const text = suggestion?.url ?? input?.trim();
    if (text) go(text);
    else field.blur();
  }
</script>

<div class="navigation">
  <button aria-label={t("chrome-ui-back")} disabled={!tab?.canGoBack} onclick={() => tab && api.command(tab.id, "back")}><Icon name="back" /></button>
  <button aria-label={t("chrome-ui-forward")} disabled={!tab?.canGoForward} onclick={() => tab && api.command(tab.id, "forward")}><Icon name="forward" /></button>
  {#if tab?.loading}
    <button aria-label={t("chrome-ui-stop")} onclick={() => api.command(tab.id, "stop")}><Icon name="close" /></button>
  {:else}
    <button aria-label={t("chrome-ui-reload")} disabled={!tab} onclick={() => tab && api.command(tab.id, "reload")}><Icon name="reload" /></button>
  {/if}
  <button
    class="compact"
    aria-label={win.compact ? t("chrome-ui-compact-leave") : t("chrome-ui-compact")}
    title="{win.compact ? t("chrome-ui-compact-leave") : t("chrome-ui-compact")} ({shortcutLabel("compact", appState.value?.settings)})"
    aria-pressed={win.compact}
    onclick={() => api.dispatch({ type: "toggleCompact", windowId: win.id })}><Icon name="bar" /></button>
  <HideButton window={win} />
  <DesignButton />
</div>
<div class="line">
<form onsubmit={validate}>
  <!-- Kept while editing, as Firefox's identity block: the text never shifts on focus. -->
  {#if connection}
    {@const label = t(connection === "secure" ? "chrome-ui-connection-secure" : "chrome-ui-connection-insecure")}
    <span class="connection" data-connection={connection} data-testid="address-connection" role="img" aria-label={label} title={label} out:fade={{ duration: 150 }}>
      <Icon name={connection === "secure" ? "lock" : "lock-open"} size={13} />
    </span>
  {/if}
  <input
    bind:this={field}
    data-testid="address-bar"
    class:with-access={agentRights}
    value={input ?? (tab ? hostName(tab.url) : "")}
    placeholder={t("chrome-ui-address")}
    spellcheck="false"
    oninput={(e) => {
      input = e.currentTarget.value;
      void suggest(input);
    }}
    onfocus={(e) => {
      input = tab?.url ?? "";
      const el = e.currentTarget;
      requestAnimationFrame(() => el.select());
    }}
    onblur={() => {
      input = null;
      closeSuggestions();
    }}
    onkeydown={clavier}
    role="combobox"
    aria-expanded={suggestions.length > 0}
    aria-controls="suggestions"
    aria-autocomplete="list"
  />
  {#if tab && agentRights}<span class="access"><AccessBadge id={tab.id} state={agentRights} /></span>{/if}
  {#if suggestions.length}
    <ul class="suggestions" id="suggestions" role="listbox">
      {#each suggestions as v, i (v.url)}
        <li
          data-testid="suggestion"
          role="option"
          aria-selected={i === chosen}
          onmousedown={(e) => {
            e.preventDefault();
            go(v.url);
          }}
        >
          <span class="title">{v.title}</span>
          <span class="url">{v.url}</span>
        </li>
      {/each}
    </ul>
  {/if}
</form>
<ExtensionsBar window={win} />
</div>

<style>
  /* 62 px: the macOS window buttons sit there (16 px from the window's edge, the pane starts at 8). */
  .navigation { display: flex; gap: 2px; padding: 0 0 6px 62px; -webkit-app-region: drag; }
  .navigation button { all: unset; width: 26px; height: 24px; display: grid; place-content: center; border-radius: 7px; color: var(--text-muted); -webkit-app-region: no-drag; transition: transform var(--tap), background var(--tap), color var(--tap); }
  .navigation button:hover:not(:disabled) { background: var(--glass-hi); color: var(--text); }
  .navigation button:active:not(:disabled) { transform: scale(0.97); }
  .navigation button:disabled { opacity: 0.35; }
  .navigation .compact { margin-left: auto; }
  .navigation .compact[aria-pressed="true"] { color: var(--accent); }
  /* The badge: a background under its first row (field and extensions), the extensions panel wraps to the line below. */
  .line { position: relative; z-index: 1; display: flex; align-items: center; flex-wrap: wrap; -webkit-app-region: no-drag; }
  .line::before { content: ""; position: absolute; z-index: -1; inset: 0 0 auto; height: 34px; box-sizing: border-box; border-radius: 10px; border: 1px solid var(--glass-edge); background: var(--glass-hi); transition: border-color var(--tap), box-shadow var(--tap); }
  .line:has(input:focus)::before { border-color: var(--accent); background: var(--sheet); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
  .line :global(.extensions) { padding-right: 3px; }
  form { position: relative; flex: 1; min-width: 80px; height: 34px; display: flex; align-items: center; }
  .connection { display: grid; place-content: center; padding-left: 10px; color: var(--text-muted); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .connection[data-connection="insecure"] { color: var(--in-progress); }
  .connection + input { padding-left: 6px; }
  .access { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); }
  .suggestions { position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 5; list-style: none; margin: 0; padding: 4px; background: var(--sheet); border: 1px solid var(--glass-edge); border-radius: 12px; box-shadow: var(--modal-shadow); animation: ressac-drop var(--spring-d) var(--spring) both; }
  .suggestions li { display: flex; flex-direction: column; padding: 6px 9px; border-radius: 8px; color: var(--text); }
  .suggestions li[aria-selected="true"], .suggestions li:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .suggestions span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .suggestions .url { font: 11px var(--font-mono); color: var(--text-muted); }
  input { flex: 1; min-width: 0; height: 100%; box-sizing: border-box; padding: 0 10px; border: none; background: none; color: var(--text); font: inherit; outline: none; -webkit-app-region: no-drag; }
  input::placeholder { color: var(--text-muted); }
  input.with-access { padding-right: 56px; }
</style>
