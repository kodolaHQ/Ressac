<script lang="ts">
  import { untrack } from "svelte";
  import type { DevRight, TabAccessState } from "@webaios/kernel";
  import { access, accessApi } from "../access.svelte";

  let { id, state: appState, anchor: anchor }: { id: string; state: TabAccessState; anchor: HTMLElement } = $props();

  const MARGIN = 8;
  const RIGHTS: Record<DevRight, { icon: string; name: string }> = {
    console: { icon: "👁", name: "Console et erreurs" },
    network: { icon: "👁", name: "Réseau" },
    performance: { icon: "👁", name: "Performances et mémoire" },
    act: { icon: "⚡", name: "Agir sur la page" },
  };

  // The web page (a native view) always covers the interface: the bubble stays in the sidebar column, under the
  // badge, and does not go past the bottom of the window. It repositions if the window is resized.
  /** Moves the bubble under <body>: a transformed or clipped ancestor would make it the `fixed` reference. */
  function subbody(node: HTMLElement) {
    document.body.append(node);
    node.focus(); // the keyboard (Escape) targets the interface, not the page
    return { destroy: () => node.remove() };
  }
  let height = $state(0);
  let windowW = $state(window.innerWidth);
  let windowH = $state(window.innerHeight);
  const place = $derived.by(() => {
    void windowW;
    void windowH;
    const column = anchor.closest("aside")?.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    // Without a sidebar (app window badge), the bubble aligns with the badge's right edge.
    const width = column ? Math.max(120, column.width - 2 * MARGIN) : Math.max(120, Math.min(280, windowW - 2 * MARGIN));
    const left = column ? column.left + MARGIN : Math.max(MARGIN, r.right - width);
    return { left, width, top: Math.max(MARGIN, Math.min(r.bottom + 6, windowH - height - MARGIN)) };
  });
  $effect(() => {
    // Read then written: without untrack, the effect would rerun itself.
    untrack(() => access.openBubbles++);
    return () => untrack(() => access.openBubbles--);
  });
</script>

<svelte:window bind:innerWidth={windowW} bind:innerHeight={windowH} />

<div class="bubble" tabindex="-1" use:subbody bind:clientHeight={height} data-testid="access-bubble" role="dialog" aria-label="Accès de l'agent" style:left="{place.left}px" style:top="{place.top}px" style:width="{place.width}px">
  <h4>{access.agent} a accès à cet onglet</h4>
  <ul>
    {#if appState.read}
      <li data-line="read"><span>👁 Lecture de la page</span></li>
    {/if}
    {#each appState.rights as d (d)}
      <li data-line={d}>
        <span>{RIGHTS[d].icon} {RIGHTS[d].name}</span>
        <button class="cut-right" data-right={d} onclick={() => accessApi.access.cut(id, d)}>Couper</button>
      </li>
    {/each}
  </ul>
  <p>Cette conversation · tombe si l'onglet change de site</p>
  <button class="cut" onclick={() => accessApi.access.cut(id)}>Couper l'accès</button>
</div>

<style>
  .bubble { position: fixed; z-index: 30; box-sizing: border-box; padding: 12px; background: var(--glass-dense); backdrop-filter: blur(30px) saturate(1.8); color: var(--text); border: 1px solid var(--glass-edge); border-radius: 14px; box-shadow: var(--modal-shadow); font-size: 12px; font-weight: 400; cursor: default; text-align: left; transform-origin: top center; animation: webaios-drop var(--spring-d) var(--spring) backwards; }
  .bubble:focus { outline: none; }
  h4 { margin: 0 0 8px; font: 600 13px/1.25 var(--font-display); }
  ul { list-style: none; margin: 0 0 8px; padding: 0; }
  li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 0; }
  li + li { border-top: 1px solid var(--border); }
  p { margin: 0 0 10px; color: var(--text-muted); font-size: 11.5px; }
  button { padding: 3px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--glass-hi); color: var(--text); font-size: 11.5px; font-weight: 600; transition: transform var(--tap), background var(--tap); }
  button:hover { background: var(--bg-hover); }
  button:active { transform: scale(0.97); }
  /* Cutting stays the semantic orange in both themes, white on it. */
  .cut { display: block; width: 100%; padding: 6px; border-radius: 10px; background: var(--access-cut); border-color: var(--access-cut); color: var(--on-color); font-size: 12px; }
  .cut:hover { background: var(--access-cut-hover); }
</style>
