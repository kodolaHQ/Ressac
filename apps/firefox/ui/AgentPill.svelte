<script lang="ts">
  import { tick } from "svelte";
  import { fade } from "svelte/transition";
  import type { AgentViewState } from "../shared/api";
  import { recapOfUrl, type BrowserState } from "../shared/model";
  import { activeSpacePrivate } from "./actions-api";
  import Icon from "./components/Icon.svelte";
  import SiteIcon from "./components/SiteIcon.svelte";

  /** The agent's last tab, as a pill over this window's pages (chrome/window/agent-pill.ts sizes its frame to it). */
  const api = window.ressac;
  let view = $state<AgentViewState | null>(api.agentView.state());
  let appState = $state<BrowserState | null>(null);
  /** ✕: hidden until the hold ends (state null); the next activity shows it again. */
  let dismissed = $state(false);
  /** Open on the thumbnail; the user reduces it by hand, and it stays reduced in this window until they grow it again. */
  let reduced = $state(false);
  const grown = $derived(!reduced);
  let thumbnail = $state<string | null>(null);
  let root = $state<HTMLElement>();
  $effect(() =>
    api.agentView.onState((s) => {
      view = s;
      if (!s) dismissed = false;
    }),
  );
  // The browser state is copied on each change: only while the agent has something to show.
  const active = $derived(view !== null);
  $effect(() => {
    if (!active) return void (appState = null);
    return api.onState((s) => (appState = s));
  });

  const shown = $derived.by(() => {
    if (!view || dismissed || !appState) return false;
    const win = appState.windows.find((w) => w.id === api.windowId);
    const active = win ? appState.tabs[win.active[win.activeSpace] ?? ""] : undefined;
    return appState.tabs[view.tab]?.windowId === api.windowId && active?.id !== view.tab && !recapOfUrl(active?.url ?? "") && !activeSpacePrivate(appState, api.windowId);
  });
  // Thumbnails only while grown (each one is a capture of the agent's tab).
  $effect(() => {
    if (!shown || !grown) return;
    const off = api.agentView.watch((f) => (thumbnail = f));
    return () => {
      off();
      thumbnail = null;
    };
  });
  // The frame covers only the pill: the rest of the page keeps the mouse. Measured after each change that resizes the
  // pill, not with a ResizeObserver: it does not fire in a window that is not painted (and the frame starts at 0×0).
  const measure = () => {
    const f = window.frameElement as HTMLElement | null;
    if (f && root) Object.assign(f.style, { width: `${root.offsetWidth}px`, height: `${root.offsetHeight}px` });
  };
  $effect(() => {
    void [shown, grown, thumbnail, view?.label];
    void tick().then(measure);
  });
</script>

<div class="root" bind:this={root}>
  {#if shown && view}
    <div
      class="pill"
      class:grown
      role="group"
      out:fade={{ duration: 150 }}
      onoutroend={() => setTimeout(measure)}
    >
      <button class="open" data-testid="agent-pill" aria-label="Voir l'onglet de l'agent" title={view.title} onclick={() => api.agentView.open()}>
        {#if grown}
          <span class="frame" data-testid="agent-pill-frame">
            {#if thumbnail}<img src={thumbnail} alt="" />{:else}<span class="site"><SiteIcon favicon={view.icon ?? null} title={view.site} size={24} />{view.site}</span>{/if}
          </span>
        {/if}
        <span class="line">
          <SiteIcon favicon={view.icon ?? null} title={view.site} />
          <span class="label" class:running={view.running}>{view.label}</span>
        </span>
      </button>
      <button class="toggle" data-testid="agent-pill-toggle" aria-label={reduced ? "Agrandir" : "Réduire"} title={reduced ? "Agrandir" : "Réduire"} onclick={() => (reduced = !reduced)}><Icon name="chevron" size={12} /></button>
      <button class="close" data-testid="agent-pill-close" aria-label="Masquer" title="Masquer" onclick={() => (dismissed = true)}><Icon name="close" size={12} /></button>
    </div>
  {/if}
</div>

<style>
  .root { position: fixed; right: 0; bottom: 0; width: max-content; }
  /* Over the site: no blur reaches it, the dense glass keeps it readable. Enter on the spring, leave by a fade (DESIGN.md). */
  .pill { position: relative; margin: 10px; border-radius: 999px; background: var(--glass-dense); border: 1px solid var(--glass-edge); box-shadow: var(--float); color: var(--text); font: 500 12px var(--font-ui); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .pill.grown { border-radius: 12px; }
  button { all: unset; cursor: pointer; transition: transform var(--tap), background var(--tap); }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .open { display: flex; flex-direction: column; gap: 6px; padding: 5px 52px 5px 8px; border-radius: inherit; }
  .grown .open { padding: 6px 52px 6px 6px; }
  .line { display: flex; align-items: center; gap: 7px; max-width: 360px; }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label.running { color: var(--accent); }
  .frame { display: grid; place-items: center; width: 360px; aspect-ratio: 16 / 10; border-radius: 8px; overflow: hidden; background: var(--glass-hi); animation: ressac-rise var(--spring-d) var(--spring) backwards; }
  .frame img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
  .site { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--text-muted); }
  .toggle, .close { position: absolute; bottom: 5px; display: grid; place-content: center; width: 20px; height: 20px; border-radius: 50%; color: var(--text-muted); }
  .close { right: 6px; }
  /* The chevron points up to grow, down to reduce. */
  .toggle { right: 28px; transform: rotate(-90deg); }
  .grown .toggle { transform: rotate(90deg); }
  .toggle:active { transform: rotate(-90deg) scale(0.97); }
  .grown .toggle:active { transform: rotate(90deg) scale(0.97); }
  .toggle:hover, .close:hover { background: var(--glass-hi); color: var(--text); }
  @media (prefers-reduced-motion: reduce) { .pill, .frame { animation: none; } }
</style>
