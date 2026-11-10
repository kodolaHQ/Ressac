<script lang="ts">
  import { untrack } from "svelte";
  import type { ShownWidget } from "../shared/api";
  import { api } from "./state.svelte";
  import { GAP_PX, ROW_PX } from "./grid";
  import { previewData } from "./builder/preview";
  import type { Executions } from "./builder/executions.svelte";
  import WidgetFrame from "./WidgetFrame.svelte";
  import { freeUnits } from "./free-grid";

  /**
   * The floating preview of the widget as the home page shows it (same isolated frame), with
   * the chosen run's data. The Firefox home places widgets freely: its placement is turned back into grid units.
   */
  let { id, runs: executions }: { id: string; runs: Executions } = $props();

  /** Width of a home column at its maximum width (1200 px, 12 columns). */
  const COLUMN_PX = 89;
  let widget = $state.raw<ShownWidget | null>(null);

  $effect(() => untrack(() => {
    let n = 0;
    const load = () => {
      const m = ++n;
      void api.home
        .read()
        .then(({ widgets }) => m === n && (widget = widgets.find((w) => w.id === id) ?? null))
        .catch(() => {});
    };
    load();
    return api.home.onChange(load);
  }));

  const shown = $derived(widget && !("error" in widget) ? widget : null);
  const preview = $derived(
    shown
      ? previewData({ chosen: executions.chosen, detail: executions.detail, list: executions.list, widget: shown })
      : null,
  );
  const size = $derived(shown ? freeUnits(shown.placement) : { w: 1, h: 1 });
  const width = $derived(Math.min(480, size.w * COLUMN_PX + (size.w - 1) * GAP_PX));
  const height = $derived(Math.min(360, size.h * ROW_PX + (size.h - 1) * GAP_PX));
</script>

<div class="preview" data-testid="widget-preview">
  {#if !shown || !preview}
    <p class="muted">{widget && "error" in widget ? `Widget illisible : ${widget.error}` : "Chargement…"}</p>
  {:else}
    <div class="frame" style:width="{width}px" style:height="{height}px">
      <WidgetFrame
        widget={shown}
        data={preview.data}
        size={size}
        state={{ status: shown.state.status, lastUpdate: shown.state.lastUpdate }}
      />
    </div>
    {#if preview.mention}<p class="muted mention" data-testid="mention-preview">Aperçu : données non gardées dans cette exécution</p>{/if}
  {/if}
</div>

<style>
  .preview { position: absolute; left: 12px; bottom: 12px; z-index: 4; display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg-bar); box-shadow: var(--modal-shadow); max-width: calc(100% - 24px); }
  .frame { display: flex; max-width: 100%; border-radius: 6px; overflow: hidden; }
  .muted { margin: 0; font-size: 11px; color: var(--text-muted); }
  .mention { max-width: 260px; }
</style>
