<script lang="ts">
  import { untrack } from "svelte";
  import { fade } from "svelte/transition";
  import type { RenderedPage } from "@webaios/kernel";
  import PageRender from "./PageRender.svelte";
  import type { PageContext } from "./types";

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
  let shown = $state.raw<{ title: string; updated: string; page: RenderedPage } | { gone: true } | undefined>(undefined);
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

<!-- An update in place fades the old version out while the new one rises in the same grid cell. -->
<div class="scrolled swap" data-testid="page-recap">
  {#key shown === undefined ? "loading" : "gone" in shown ? "gone" : shown.updated}
    <div class="version" out:fade={{ duration: 150 }}>
      {#if shown === undefined}
        <p class="message" data-testid="recap-loading">Chargement…</p>
      {:else if "gone" in shown}
        <p class="message" data-testid="recap-gone">Ce récap a été fermé.</p>
      {:else}
        <p class="message" data-testid="recap-meta">Récap de l'agent · {date(shown.updated)}</p>
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
</style>
