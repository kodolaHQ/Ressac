<script lang="ts">
  import { AURA_IDS } from "../../shared/aura";
  import AuraDot from "./AuraDot.svelte";

  /** A drawing of the sidebar for the welcome (not a capture): the ⌘T field, a list of tabs, the spaces at the bottom. */
  const TABS = [72, 54, 64, 46];
</script>

<div class="sketch" aria-hidden="true">
  <div class="field"><span class="line" style:width="48%"></span><kbd>⌘T</kbd></div>
  <div class="tabs">
    {#each TABS as width, i (i)}
      <div class="tab" class:current={i === 1}><span class="icon"></span><span class="line" style:width="{width}%"></span></div>
    {/each}
  </div>
  <div class="spaces">
    {#each AURA_IDS.slice(0, 3) as id, i (id)}
      <span class="space" class:current={i === 0}><AuraDot aura={id} size={10} /></span>
    {/each}
  </div>
</div>

<style>
  .sketch {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 200px;
    height: 220px;
    padding: 12px 10px;
    box-sizing: border-box;
    border: 1px solid var(--glass-edge);
    border-radius: 16px;
    background: linear-gradient(color-mix(in oklab, var(--a1) 14%, var(--glass)), var(--glass) 55%);
    box-shadow: var(--float);
  }
  .field { display: flex; align-items: center; justify-content: space-between; height: 28px; padding: 0 8px; border-radius: 10px; background: var(--glass-hi); border: 1px solid var(--border); }
  .tabs { display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .tab { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 8px; border-radius: 10px; }
  .tab.current { background: var(--glass-hi); box-shadow: var(--lift), inset 0 0 0 1px var(--glass-edge); }
  .icon { width: 12px; height: 12px; flex: none; border-radius: 4px; background: color-mix(in oklab, var(--accent) 55%, var(--glass-hi)); }
  .line { display: block; height: 6px; border-radius: 3px; background: color-mix(in oklab, var(--text) 22%, transparent); }
  .current .line { background: color-mix(in oklab, var(--text) 40%, transparent); }
  .spaces { display: flex; justify-content: center; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
  .space { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; }
  .space.current { background: var(--glass-hi); box-shadow: inset 0 0 0 1px var(--glass-edge); }
</style>
