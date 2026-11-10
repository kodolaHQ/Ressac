<script lang="ts">
  import ExtensionsBar from "../ExtensionsStrip.svelte";
  import DesignButton from "./DesignButton.svelte";
  import AccessBadge from "./AccessBadge.svelte";
  import Icon from "./Icon.svelte";
  import type { WindowState, Visit } from "../../shared/model";
  import { accessOf, api, appState } from "../state.svelte";

  let { window: win }: { window: WindowState } = $props();
  const tab = $derived.by(() => {
    const id = win.active[win.activeSpace];
    return id ? appState.value?.tabs[id] : undefined;
  });
  const agentRights = $derived(tab ? accessOf(tab.id) : undefined);
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
  <button aria-label="Reculer" disabled={!tab?.canGoBack} onclick={() => tab && api.command(tab.id, "back")}><Icon name="back" /></button>
  <button aria-label="Avancer" disabled={!tab?.canGoForward} onclick={() => tab && api.command(tab.id, "forward")}><Icon name="forward" /></button>
  {#if tab?.loading}
    <button aria-label="Arrêter" onclick={() => api.command(tab.id, "stop")}><Icon name="close" /></button>
  {:else}
    <button aria-label="Recharger" disabled={!tab} onclick={() => tab && api.command(tab.id, "reload")}><Icon name="reload" /></button>
  {/if}
  <button
    class="compact"
    aria-label={win.compact ? "Quitter le mode compact" : "Mode compact"}
    title={win.compact ? "Quitter le mode compact (⌘⇧S)" : "Mode compact (⌘⇧S)"}
    aria-pressed={win.compact}
    onclick={() => api.dispatch({ type: "toggleCompact", windowId: win.id })}><Icon name="bar" /></button>
  <DesignButton />
</div>
<div class="line">
<form onsubmit={validate}>
  <input
    bind:this={field}
    data-testid="address-bar"
    class:with-access={agentRights}
    value={input ?? (tab ? hostName(tab.url) : "")}
    placeholder="Rechercher ou saisir une adresse"
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
  .navigation { display: flex; gap: 2px; padding: 0 2px 6px 70px; -webkit-app-region: drag; }
  .navigation button { all: unset; width: 26px; height: 24px; display: grid; place-content: center; border-radius: 5px; color: var(--text-muted); -webkit-app-region: no-drag; }
  .navigation button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
  .navigation button:disabled { opacity: 0.35; }
  .navigation .compact { margin-left: auto; }
  .navigation .compact[aria-pressed="true"] { color: var(--accent); }
  /* The badge: a background under its first row (field and extensions), the extensions panel wraps to the line below. */
  .line { position: relative; z-index: 1; display: flex; align-items: center; flex-wrap: wrap; -webkit-app-region: no-drag; }
  .line::before { content: ""; position: absolute; z-index: -1; inset: 0 0 auto; height: 34px; box-sizing: border-box; border-radius: 10px; border: 1px solid transparent; background: var(--bg-hover); }
  .line:has(input:focus)::before { border-color: var(--accent); background: var(--bg); }
  .line :global(.extensions) { padding-right: 3px; }
  form { position: relative; flex: 1; min-width: 80px; height: 34px; }
  .access { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); }
  .suggestions { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 5; list-style: none; margin: 0; padding: 4px; background: var(--bg-active); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35); }
  .suggestions li { display: flex; flex-direction: column; padding: 5px 8px; border-radius: 5px; color: var(--text); }
  .suggestions li[aria-selected="true"], .suggestions li:hover { background: var(--bg-hover); }
  .suggestions span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .suggestions .url { font-size: 11px; color: var(--text-muted); }
  input { width: 100%; height: 100%; box-sizing: border-box; padding: 0 10px; border: none; background: none; color: var(--text); outline: none; -webkit-app-region: no-drag; }
  input.with-access { padding-right: 56px; }
</style>
