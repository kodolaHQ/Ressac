<script lang="ts">
  import type { HideRect, MarksApi } from "../shared/api";

  // « Voir ce qu'il ne voit pas » (chrome/window/hide-layer.ts mountMarks): a hatch over each text the agent receives
  // masked, while its aura is on. Drawn here, over the page, never in it. The marks come in on the spring with the aura
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
  const gone = () => {
    if (!on) rects = [];
  };
</script>

<div class="marks" class:on data-testid="hide-marks" ontransitionend={gone} ontransitioncancel={gone}>
  {#each rects as r, i (i)}<i class="mark" data-testid="hide-mark" style="left: {r.x}px; top: {r.y}px; width: {r.width}px; height: {r.height}px"></i>{/each}
</div>

<style>
  :global(html), :global(body), :global(#app) { margin: 0; height: 100%; overflow: hidden; }
  .marks { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity 150ms ease-out; }
  /* --spring-d is 150 ms with reduced motion (theme.css). */
  .marks.on { opacity: 1; transition: opacity var(--spring-d) var(--spring); @starting-style { opacity: 0; } }
  .mark { position: absolute; border-radius: 4px; background: repeating-linear-gradient(-45deg, color-mix(in srgb, var(--accent) 35%, transparent) 0 2px, transparent 2px 5px); }
</style>
