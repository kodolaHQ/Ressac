<script lang="ts">
  import type { TabsPanel } from "../../shared/api";
  import { api, appState } from "../state.svelte";
  import AuraEmoji from "./AuraEmoji.svelte";
  import SiteIcon from "./SiteIcon.svelte";

  /**
   * ⌃Tab panel: recent tabs as preview cards, the selection outlined. The main process holds the traversal (order,
   * selection, ⌃ release); the panel only displays it and sends back mouse, Escape and ⌃ release.
   */
  let { panel: panel }: { panel: TabsPanel } = $props();

  const send = api.tabCycle;
  const spaceOf = (id: string) => {
    const s = appState.value;
    return s?.spaces.find((e) => e.id === s.tabs[id]?.spaceId);
  };

  /**
   * The mouse only picks a card after a real movement: a panel that appears (or changes cards) under a still mouse
   * must not steal the keyboard selection. Chromium then sends moves at the same place.
   */
  let place: { x: number; y: number } | null = null;
  /** The move being processed really moved (noted in capture, before the card). */
  let moved = false;
  const notePlace = (e: PointerEvent) => {
    moved = !!place && (place.x !== e.screenX || place.y !== e.screenY);
    place = { x: e.screenX, y: e.screenY };
  };
</script>

<!-- In capture: the panel goes before everything else (modal, history…), and Escape only closes it. -->
<svelte:window
  onpointermovecapture={notePlace}
  onkeyup={(e) => {
    // Redundant with the interface's `before-input-event` (no effect outside a traversal): the panel never stays stuck.
    if (e.key === "Control") send({ type: "confirm" });
  }}
  onkeydowncapture={(e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      send({ type: "cancel" });
    }
    // ⌃Tab and ⌃⇧Tab: the menu accelerator already advances the traversal, interface focus included. Nothing to send here
    // (it would be a double step), and above all no preventDefault: a key consumed by the page no longer reaches the menu.
  }}
/>

<div class="panel" data-testid="tabs-panel" role="listbox" aria-label="Onglets récents">
  {#each panel.cards as card, i (card.id)}
    {@const space = spaceOf(card.id)}
    <div
      class="card"
      style:animation-delay="{i * 45}ms"
      data-testid="tab-card"
      role="option"
      tabindex="-1"
      aria-selected={i === panel.selection}
      title={card.title}
      onpointermove={() => moved && i !== panel.selection && send({ type: "hover", id: card.id })}
      onclick={() => send({ type: "choose", id: card.id })}
    >
      <div class="preview">
        {#if card.preview}
          <img src={card.preview} alt="" />
        {:else}
          <div class="fallback"><SiteIcon favicon={card.favicon} title={card.title} size={40} /></div>
        {/if}
      </div>
      <div class="legend">
        <SiteIcon favicon={card.favicon} title={card.title} />
        <span class="title">{card.title}</span>
        {#if space}<span class="space" title={space.name}><AuraEmoji icon={space.icon} aura={space.aura} /></span>{/if}
      </div>
    </div>
  {/each}
</div>

<style>
  .panel {
    position: fixed;
    inset: 0;
    /* Above the modals (100): an agent request arriving during the traversal does not cover it. */
    z-index: 101;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 16px;
    -webkit-app-region: no-drag;
  }
  /* Glass cards over the frozen, blurred window: they rise in cascade, the selected one lifts on the spring. */
  .card {
    flex: 0 1 280px;
    min-width: 0;
    padding: 8px;
    background: var(--glass-dense);
    backdrop-filter: blur(30px) saturate(1.8);
    color: var(--text);
    border: 1px solid var(--glass-edge);
    border-radius: 16px;
    box-shadow: var(--modal-shadow);
    cursor: pointer;
    outline: none;
    transition: transform var(--spring-d) var(--spring), border-color var(--tap), box-shadow var(--tap);
    animation: webaios-rise var(--spring-d) var(--spring) backwards;
  }
  .card[aria-selected="true"] { transform: scale(1.04); border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), var(--modal-shadow); }
  .card:active { transform: scale(0.97); }
  .preview { aspect-ratio: 16 / 10; overflow: hidden; border-radius: 10px; background: var(--sheet); }
  .preview img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
  /* No capture: a wash of the window's aura behind the icon. */
  .fallback { display: grid; place-items: center; height: 100%; background: linear-gradient(135deg, color-mix(in oklab, var(--a1) 22%, var(--sheet)), color-mix(in oklab, var(--a2) 22%, var(--sheet))); }
  .legend { display: flex; align-items: center; gap: 8px; margin: 8px 2px 1px; font-size: 13px; }
  .card[aria-selected="true"] .title { font-weight: 500; }
  .space { flex: none; font-size: 12px; margin-right: 2px; }
  .title { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
