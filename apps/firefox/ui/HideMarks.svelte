<script lang="ts">
  import type { HideRect, MarksApi } from "../shared/api";
  import { format } from "../shared/i18n";

  // « Voir ce qu'il ne voit pas » (chrome/window/hide-layer.ts mountMarks): a hatch over each text the agent receives
  // masked, while its aura is on or the viewfinder is armed; a form field's value in its own colour, and a legend
  // naming the kinds in view. Drawn here, over the page, never in it. The marks come in on the spring with the aura
  // and leave by a 150 ms fade; they are dropped once the fade is over.
  const api = window.ressac as unknown as MarksApi;
  let rects = $state<HideRect[]>([]);
  let on = $state(false);
  function update() {
    const r = api.marks();
    on = r !== null;
    if (r) rects = r;
  }
  update();
  api.onChange(update);
  const t = (id: string) => format(api.locale(), id);
  const texts = $derived(rects.some((r) => !r.field));
  const fields = $derived(rects.some((r) => r.field));
  const gone = () => {
    if (!on) rects = [];
  };
</script>

<div class="marks" class:on data-testid="hide-marks" ontransitionend={gone} ontransitioncancel={gone}>
  {#each rects as r, i (i)}<i class="mark" class:field={r.field} data-testid="hide-mark" style="left: {r.x}px; top: {r.y}px; width: {r.width}px; height: {r.height}px"></i>{/each}
  {#if texts || fields}
    <div class="legend" data-testid="hide-legend">
      {#if texts}<span><i class="swatch"></i>{t("chrome-hide-legend-text")}</span>{/if}
      {#if fields}<span><i class="swatch field"></i>{t("chrome-hide-legend-field")}</span>{/if}
    </div>
  {/if}
</div>

<style>
  :global(html), :global(body), :global(#app) { margin: 0; height: 100%; overflow: hidden; }
  .marks { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity 150ms ease-out; }
  /* --spring-d is 150 ms with reduced motion (theme.css). */
  .marks.on { opacity: 1; transition: opacity var(--spring-d) var(--spring); @starting-style { opacity: 0; } }
  .mark, .swatch { border-radius: 4px; background: repeating-linear-gradient(-45deg, color-mix(in srgb, var(--accent) 35%, transparent) 0 2px, transparent 2px 5px); }
  .mark { position: absolute; }
  /* A field's value: the aura's third colour, outlined, so a whole box reads apart from a word. */
  .mark.field, .swatch.field { background: repeating-linear-gradient(45deg, color-mix(in srgb, var(--a3) 45%, transparent) 0 2px, transparent 2px 5px); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--a3) 60%, transparent); }
  .legend { position: absolute; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 10px; background: var(--glass-dense); box-shadow: 0 0 0 1px var(--glass-edge), var(--float); color: var(--text); font: 500 12px/1.4 var(--font-ui); }
  .legend span { display: flex; align-items: center; gap: 8px; }
  .swatch { display: inline-block; width: 22px; height: 12px; flex: none; }
</style>
