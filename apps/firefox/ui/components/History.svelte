<script lang="ts">
  import Icon from "./Icon.svelte";
  import { openMenu } from "./menu.svelte";
  import type { WindowState, Visit } from "../../shared/model";
  import { api, appState } from "../state.svelte";
  import { t } from "../i18n.svelte";
  import { SEARCH_PAUSE_MS } from "./command";

  let { window: win, close }: { window: WindowState; close: () => void } = $props();
  const locale = $derived(appState.value?.locale ?? "fr");
  let text = $state("");
  let visits = $state<Visit[]>([]);
  let clearChoice = $state(false);
  let field: HTMLInputElement;
  let request = 0;

  async function load() {
    const n = ++request;
    const r = text.trim() ? await api.history.search(text.trim(), 200) : await api.history.recent();
    if (n === request) visits = r;
  }

  // Searched once typing pauses: every query holds the host's database while it runs.
  $effect(() => {
    void text;
    const timer = setTimeout(load, text.trim() ? SEARCH_PAUSE_MS : 0);
    return () => clearTimeout(timer);
  });
  $effect(() => field.focus());

  function day(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return t("sidebar-history-today");
    if (d.toDateString() === yesterday.toDateString()) return t("sidebar-history-yesterday");
    return d.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }

  const groups = $derived.by(() => {
    const g: { day: string; visits: Visit[] }[] = [];
    for (const v of visits) {
      const j = day(v.lastVisit);
      if (g.at(-1)?.day !== j) g.push({ day: j, visits: [] });
      g.at(-1)!.visits.push(v);
    }
    return g;
  });

  async function clear(from?: Date) {
    clearChoice = false;
    await api.history.clear(from?.toISOString());
    api.dispatch({ type: "clearRecentlyClosed" });
    await load();
  }

  function open(e: MouseEvent, url: string) {
    e.preventDefault();
    if (e.button !== 0) return;
    api.dispatch({ type: "openTab", windowId: win.id, url });
    close();
  }

  function visitMenu(e: MouseEvent, v: Visit) {
    if (!v.kept) return;
    openMenu(e, [{ label: t("sidebar-history-forget"), dispatch: () => void api.history.forgetText(v.url, v.spaceId).then(load) }], { free: true });
  }

    const dayStart = () => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  };
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && close()} />

<section class="history" data-testid="history" aria-label={t("sidebar-history")}>
  <header>
    <h1>{t("sidebar-history")}</h1>
    <input bind:this={field} type="search" bind:value={text} placeholder={t("sidebar-history-search")} spellcheck="false" />
    <div class="clear">
      <button onclick={() => (clearChoice = !clearChoice)}>{t("sidebar-history-clear")}</button>
      {#if clearChoice}
        <div class="choice">
          <button onclick={() => clear(new Date(Date.now() - 3600_000))}>{t("sidebar-history-clear-hour")}</button>
          <button onclick={() => clear(dayStart())}>{t("sidebar-history-today")}</button>
          <button onclick={() => clear()}>{t("sidebar-history-clear-all")}</button>
        </div>
      {/if}
    </div>
    <button class="close" aria-label={t("sidebar-history-close")} onclick={close}><Icon name="close" size={12} /></button>
  </header>
  {#each groups as g (g.day)}
    <h2>{g.day}</h2>
    <ul>
      {#each g.visits as v (`${v.spaceId}|${v.url}`)}
        <li data-private={v.private ? "true" : undefined} data-kept={v.kept ? "true" : undefined}>
          <a href={v.url} onclick={(e) => open(e, v.url)} oncontextmenu={(e) => visitMenu(e, v)}>
            <span class="time">{new Date(v.lastVisit).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</span>
            {#if v.private}<span class="padlock" title={t("sidebar-history-private")} aria-label={t("sidebar-history-private")}><Icon name="lock" size={12} /></span>{/if}
            <span class="title">{v.title}</span>
            {#if v.kept}<span class="kept" title={t("sidebar-history-kept")} aria-label={t("sidebar-history-kept")}><Icon name="agent" size={12} /></span>{/if}
            <span class="url">{v.url}</span>
          </a>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">{t(text ? "sidebar-history-no-result" : "sidebar-history-empty")}</p>
  {/each}
</section>

<style>
  .history { height: 100%; overflow-y: auto; box-sizing: border-box; padding: 26px 32px; color: var(--text); }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  h1 { margin: 0; font: 650 26px/1.1 var(--font-display); letter-spacing: -0.02em; }
  header input { flex: 1; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); outline: none; }
  header input:focus { border-color: var(--accent); }
  header button { padding: 6px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font: 600 12px var(--font-ui); transition: transform var(--tap), background var(--tap); }
  header button:active { transform: scale(0.97); }
  .close { border: none; background: none; }
  .clear { position: relative; }
  .choice { position: absolute; right: 0; top: 110%; display: flex; flex-direction: column; gap: 2px; padding: 4px; background: var(--glass-dense); border: 1px solid var(--glass-edge); border-radius: 12px; box-shadow: var(--modal-shadow); z-index: 1; animation: ressac-drop var(--spring-d) var(--spring) backwards; }
  h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin: 22px 4px 8px; }
  ul { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 16px; background: var(--sheet); box-shadow: var(--lift); overflow: hidden; padding: 4px; }
  a { display: flex; gap: 12px; padding: 7px 10px; border-radius: 10px; color: inherit; text-decoration: none; }
  a:hover { background: var(--bg-hover); }
  .time { color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .padlock, .kept { display: flex; align-items: center; }
  .kept { opacity: 0.7; }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .url { margin-left: auto; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
  .empty { color: var(--text-muted); }
</style>
