<script lang="ts">
  import { api } from "../state.svelte";
  import { design } from "./design.svelte";
  import { openMenu, type MenuEntry } from "./menu.svelte";

  const e = $derived(design.state);
  const unavailable = $derived(!e || e.unavailable !== null);

  function menu(ev: MouseEvent) {
    const entries: MenuEntry[] = [{ label: "Panier", dispatch: () => (design.basketRequested = true) }];
    // Task 11: the review of the agent's apps and external projects.
    if (e?.project && e.project.type !== "demo") entries.push({ label: "Relire ce projet", dispatch: () => api.design.review() });
    openMenu(ev, entries);
  }
</script>

<span class="design">
  <button
    class="bouton"
    data-testid="bouton-design"
    aria-label="Mode design"
    aria-pressed={e?.active ?? false}
    disabled={unavailable}
    title={unavailable ? (e?.unavailable ?? "") : "Mode design (⌘⇧D)"}
    onclick={() => api.design.toggle()}
    >✎{#if e && e.basket > 0}<span class="compteur" data-testid="compteur-panier">{e.basket}</span>{/if}</button
  >
  <button class="chevron" aria-label="Menu du mode design" disabled={unavailable} onclick={menu}>▾</button>
</span>

<style>
  .design { display: inline-flex; -webkit-app-region: no-drag; }
  button { all: unset; height: 24px; display: grid; grid-auto-flow: column; align-items: center; gap: 3px; border-radius: 5px; color: var(--texte-doux); cursor: pointer; }
  .bouton { padding: 0 6px; }
  .chevron { width: 14px; justify-content: center; font-size: 10px; }
  button:hover:not(:disabled) { background: var(--fond-survol); color: var(--texte); }
  button:disabled { opacity: 0.35; cursor: default; }
  .bouton[aria-pressed="true"] { color: var(--accent); }
  .compteur { min-width: 14px; padding: 0 3px; box-sizing: border-box; border-radius: 7px; background: var(--accent); color: #fff; font-size: 10px; line-height: 14px; text-align: center; }
</style>
