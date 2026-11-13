<script lang="ts">
  import { untrack } from "svelte";
  import { fade } from "svelte/transition";
  import type { RenderedBlock, RenderedPage } from "@webaios/kernel";
  import type { AgentViewState } from "../../shared/api";
  import SiteIcon from "../components/SiteIcon.svelte";
  import PageRender from "./PageRender.svelte";
  import { sections, type Collection, type PageContext } from "./types";

  /**
   * The page `webaios://recap/<id>`: a recap the agent published, drawn like an action page. Its links and images are
   * allowed only if the agent read their address. Only a missing file is « fermé »: a host not ready yet is read again.
   */
  let { id }: { id: string } = $props();

  const recaps = window.webaios.recaps;
  const ctx: PageContext = { openLink: (url) => recaps.openLink(id, url), image: (url) => recaps.image(id, url) };
  const FORMAT = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  const date = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : FORMAT.format(d);
  };

  /** undefined: not read yet. */
  let shown = $state.raw<{ title: string; updated: string; live: boolean; page: RenderedPage } | { gone: true } | undefined>(undefined);
  const live = $derived(shown !== undefined && !("gone" in shown) && shown.live);

  /** What the agent kept so far: every card, plus one per highlight. */
  const kept = (blocks: RenderedBlock[] | undefined): number =>
    (blocks ?? []).reduce((n, b) => {
      if ("message" in b) return n;
      const own = b.component === "highlight" ? 1 : b.component === "cards" ? sections(b.props as Collection<unknown>).reduce((k, s) => k + s.items.length, 0) : 0;
      return n + own + kept(b.blocks) + kept(b.left) + kept(b.right);
    }, 0);
  const count = $derived(shown && !("gone" in shown) ? kept(shown.page.blocks) : 0);

  // The agent's tab while the recap fills: thumbnails only while live (this page is mounted only while its tab shows).
  let view = $state<AgentViewState | null>(window.webaios.agentView.state());
  let thumbnail = $state<string | null>(null);
  $effect(() => {
    const off = window.webaios.agentView.onState((s) => (view = s));
    view = window.webaios.agentView.state();
    return off;
  });
  // Every state is a fresh copy: watch again (and drop the old frame) only when the agent's tab changes.
  const watched = $derived(live && view ? view.tab : null);
  $effect(() => {
    if (!watched) return;
    const off = window.webaios.agentView.watch((f) => (thumbnail = f));
    return () => {
      off();
      thumbnail = null;
    };
  });
  let generation = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let unmounted = false;
  async function load() {
    const g = ++generation;
    clearTimeout(retry);
    const r = await recaps.page(id).catch(() => null);
    if (g !== generation || unmounted) return;
    // shortcut: retried every 2 s while it answers nothing (an unreadable file too), add a bound if it ever costs.
    if (r === null) retry = setTimeout(() => void load(), 2000);
    else shown = r;
  }

  $effect(() => {
    untrack(() => void load());
    const end = recaps.onChange((changed) => (changed === null || changed === id) && void load());
    return () => {
      unmounted = true;
      clearTimeout(retry);
      end();
    };
  });
</script>

<!-- An update in place fades the old version out while the new one rises in the same grid cell. A live update keeps the
     version: its cards stay, new ones rise. -->
<div class="scrolled swap" data-testid="page-recap">
  {#key shown === undefined ? "loading" : "gone" in shown ? "gone" : shown.live ? "live" : shown.updated}
    <div class="version" out:fade={{ duration: 150 }}>
      {#if shown === undefined}
        <p class="message" data-testid="recap-loading">Chargement…</p>
      {:else if "gone" in shown}
        <p class="message" data-testid="recap-gone">Ce récap a été fermé.</p>
      {:else}
        <div class="head">
          <p class="message" data-testid="recap-meta">
            Récap de l'agent · {date(shown.updated)}
            {#if live}<span class="live" data-testid="recap-live" out:fade={{ duration: 150 }}>en direct{count ? ` · ${count} retenue${count > 1 ? "s" : ""}` : ""}</span>{/if}
          </p>
          {#if live && view}
            <button class="view" data-testid="recap-agent-view" title={view.title} onclick={() => window.webaios.agentView.open()} out:fade={{ duration: 150 }}>
              <span class="frame">
                {#if thumbnail}<img src={thumbnail} alt="" />{:else}<span class="site"><SiteIcon favicon={view.icon ?? null} title={view.site} size={24} />{view.site}</span>{/if}
              </span>
              <span class="label" class:running={view.running}>{view.label}</span>
            </button>
          {/if}
        </div>
        <PageRender page={shown.page} {ctx} components={false} />
        <p class="message foot">Ce récap disparaît quand tu fermes l'onglet.</p>
      {/if}
    </div>
  {/key}
</div>

<style>
  .scrolled { position: absolute; inset: 0; overflow: auto; }
  .swap { display: grid; align-content: start; }
  .version { grid-area: 1 / 1; min-width: 0; }
  .message { max-width: 960px; box-sizing: border-box; margin: 16px auto 0; padding: 0 24px; color: var(--text-muted); font-size: 12px; animation: webaios-rise var(--spring-d) var(--spring) both; }
  .foot { margin: 0 auto 32px; }
  .head { max-width: 960px; box-sizing: border-box; margin: 0 auto; padding: 0 24px; display: flex; justify-content: space-between; align-items: start; gap: 16px; }
  .head .message { margin: 16px 0 0; padding: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .live { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--running) 14%, transparent); color: var(--running); font-size: 11px; animation: webaios-rise var(--spring-d) var(--spring) both; }
  .live::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  /* Enter on the spring, leave by a fade (DESIGN.md); the dense glass keeps it readable over the aura. */
  .view { all: unset; cursor: pointer; flex: none; display: flex; flex-direction: column; gap: 6px; width: 200px; margin-top: 16px; padding: 6px; border-radius: 12px; background: var(--glass-dense); border: 1px solid var(--glass-edge); box-shadow: var(--float); color: var(--text); font: 500 12px var(--font-ui); transition: transform var(--tap); animation: webaios-rise var(--spring-d) var(--spring) both; }
  .view:active { transform: scale(0.97); }
  .view:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .frame { display: grid; place-items: center; aspect-ratio: 16 / 10; border-radius: 8px; overflow: hidden; background: var(--glass-hi); }
  .frame img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
  .site { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--text-muted); }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label.running { color: var(--accent); }
  /* A card added while the recap fills rises on its own; the others keep their place. */
  .version :global(.pa-cards > .pa-card) { animation: webaios-rise var(--spring-d) var(--spring) both; }
</style>
