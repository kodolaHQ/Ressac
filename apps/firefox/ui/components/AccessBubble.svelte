<script lang="ts">
  import { untrack } from "svelte";
  import type { DevRight, TabAccessState } from "@webaios/kernel";
  import { access, accessApi } from "../access.svelte";

  let { id, etat: appState, ancre: anchor }: { id: string; etat: TabAccessState; ancre: HTMLElement } = $props();

  const MARGIN = 8;
  const RIGHTS: Record<DevRight, { icone: string; nom: string }> = {
    console: { icone: "👁", nom: "Console et erreurs" },
    reseau: { icone: "👁", nom: "Réseau" },
    performances: { icone: "👁", nom: "Performances et mémoire" },
    agir: { icone: "⚡", nom: "Agir sur la page" },
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
    untrack(() => access.bullesOuvertes++);
    return () => untrack(() => access.bullesOuvertes--);
  });
</script>

<svelte:window bind:innerWidth={windowW} bind:innerHeight={windowH} />

<div class="bulle" tabindex="-1" use:subbody bind:clientHeight={height} data-testid="bulle-acces" role="dialog" aria-label="Accès de l'agent" style:left="{place.left}px" style:top="{place.top}px" style:width="{place.width}px">
  <h4>{access.agent} a accès à cet onglet</h4>
  <ul>
    {#if appState.lecture}
      <li data-ligne="lecture"><span>👁 Lecture de la page</span></li>
    {/if}
    {#each appState.droits as d (d)}
      <li data-ligne={d}>
        <span>{RIGHTS[d].icone} {RIGHTS[d].nom}</span>
        <button class="couper-droit" data-droit={d} onclick={() => accessApi.acces.couper(id, d)}>Couper</button>
      </li>
    {/each}
  </ul>
  <p>Cette conversation · tombe si l'onglet change de site</p>
  <button class="couper" onclick={() => accessApi.acces.couper(id)}>Couper l'accès</button>
</div>

<style>
  .bulle { position: fixed; z-index: 30; box-sizing: border-box; padding: 10px; background: var(--fond-actif); color: var(--texte); border: 1px solid var(--bord); border-radius: 9px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); font-size: 12px; font-weight: 400; cursor: default; text-align: left; }
  .bulle:focus { outline: none; }
  h4 { margin: 0 0 6px; font-size: 12px; }
  ul { list-style: none; margin: 0 0 6px; padding: 0; }
  li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; }
  p { margin: 0 0 8px; color: var(--texte-doux); font-size: 11.5px; }
  button { padding: 3px 9px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-size: 11.5px; font-weight: 600; }
  button:hover { background: var(--fond-survol); }
  .couper { display: block; width: 100%; padding: 5px; background: var(--acces-couper); border-color: var(--acces-couper); color: white; font-size: 12px; }
  .couper:hover { background: var(--acces-couper-survol); }
</style>
