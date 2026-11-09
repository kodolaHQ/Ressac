<script lang="ts">
  import type { TabsPanel } from "../../shared/api";
  import { api } from "../state.svelte";
  import SiteIcon from "./SiteIcon.svelte";

  /**
   * ⌃Tab panel: recent tabs as preview cards, the selection outlined. The main process holds the traversal (order,
   * selection, ⌃ release); the panel only displays it and sends back mouse, Escape and ⌃ release.
   */
  let { panneau: panel }: { panneau: TabsPanel } = $props();

  const send = api.parcoursOnglets;

  /**
   * The mouse only picks a card after a real movement: a panel that appears (or changes cards) under a still mouse
   * must not steal the keyboard selection. Chromium then sends moves at the same place.
   */
  let place: { x: number; y: number } | null = null;
  /** The move being processed really moved (noted in capture, before the card). */
  let bouge = false;
  const noterPlace = (e: PointerEvent) => {
    bouge = !!place && (place.x !== e.screenX || place.y !== e.screenY);
    place = { x: e.screenX, y: e.screenY };
  };
</script>

<!-- In capture: the panel goes before everything else (modal, history…), and Escape only closes it. -->
<svelte:window
  onpointermovecapture={noterPlace}
  onkeyup={(e) => {
    // Redundant with the interface's `before-input-event` (no effect outside a traversal): the panel never stays stuck.
    if (e.key === "Control") send({ type: "valider" });
  }}
  onkeydowncapture={(e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      send({ type: "annuler" });
    }
    // ⌃Tab and ⌃⇧Tab: the menu accelerator already advances the traversal, interface focus included. Nothing to send here
    // (it would be a double step), and above all no preventDefault: a key consumed by the page no longer reaches the menu.
  }}
/>

<div class="panneau" data-testid="panneau-onglets" role="listbox" aria-label="Onglets récents">
  {#each panel.cartes as carte, i (carte.id)}
    <div
      class="carte"
      data-testid="carte-onglet"
      role="option"
      tabindex="-1"
      aria-selected={i === panel.selection}
      title={carte.titre}
      onpointermove={() => bouge && i !== panel.selection && send({ type: "survoler", id: carte.id })}
      onclick={() => send({ type: "choisir", id: carte.id })}
    >
      <div class="apercu">
        {#if carte.apercu}
          <img src={carte.apercu} alt="" />
        {:else}
          <div class="secours"><SiteIcon favicon={carte.favicon} titre={carte.titre} taille={40} /></div>
        {/if}
      </div>
      <div class="legende">
        <SiteIcon favicon={carte.favicon} titre={carte.titre} />
        <span class="titre">{carte.titre}</span>
      </div>
    </div>
  {/each}
</div>

<style>
  .panneau {
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
  .carte {
    flex: 0 1 280px;
    min-width: 0;
    padding: 8px;
    background: var(--fond-actif);
    color: var(--texte);
    border: 2px solid transparent;
    border-radius: 12px;
    box-shadow: var(--ombre-modale);
    cursor: pointer;
    outline: none;
  }
  .carte[aria-selected="true"] { border-color: var(--accent); }
  .apercu { aspect-ratio: 16 / 10; overflow: hidden; border-radius: 7px; background: var(--fond-barre); }
  .apercu img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
  .secours { display: grid; place-items: center; height: 100%; }
  .legende { display: flex; align-items: center; gap: 6px; margin-top: 7px; font-size: 13px; }
  .titre { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
