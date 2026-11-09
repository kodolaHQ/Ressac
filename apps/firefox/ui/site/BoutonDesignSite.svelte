<script lang="ts">
  import type { ApiSite, EtatDesign } from "../../shared/api";
  import type { EtatFenetreSite } from "../../shared/sites";

  // The app's design mode (plan 18): ✎ (⌘⇧D), its counter, and the « Panier » / « Relire ce projet » chevron. A list
  // under the bar would be hidden by the site's view: both entries unfold in the bar, in place of the title
  // (`menuOuvert`, read by the bar), and fold back on choice, on Escape, on a click elsewhere in the bar or after 5 s.
  let { api, etat, menuOuvert = $bindable(false) }: { api: ApiSite; etat: EtatFenetreSite; menuOuvert?: boolean } = $props();
  const DUREE_MENU_MS = 5000;
  let design = $state<EtatDesign | null>(null);
  let racine = $state<HTMLElement | null>(null);
  let lecture = 0;

  async function relire(): Promise<void> {
    const n = ++lecture;
    const e = await api.design.etat().catch(() => null);
    if (n === lecture) design = e;
  }

  // Re-read on each window state received (view, page, full screen…) and on each change of the mode or the basket.
  $effect(() => {
    void etat;
    void relire();
  });
  $effect(() => api.design.surChange(() => void relire()));

  const actif = $derived(design?.actif ?? false);
  const indisponible = $derived(!design || design.indisponible !== null);

  // Folds back by itself after 5 s.
  $effect(() => {
    if (!menuOuvert) return;
    const minuterie = setTimeout(() => (menuOuvert = false), DUREE_MENU_MS);
    return () => clearTimeout(minuterie);
  });

  function choisir(agir: () => void) {
    menuOuvert = false;
    agir();
  }
  function clicAilleurs(e: MouseEvent) {
    if (menuOuvert && racine && !(e.target instanceof Node && racine.contains(e.target))) menuOuvert = false;
  }
</script>

<svelte:window onkeydown={(e) => menuOuvert && e.key === "Escape" && (menuOuvert = false)} onclick={clicAilleurs} />

<span class="design" bind:this={racine}>
  {#if menuOuvert}
    <span class="entrees" role="menu" aria-label="Mode design">
      <button role="menuitem" data-testid="site-menu-design-panier" onclick={() => choisir(() => api.design.ouvrirPanier())}>Panier</button>
      <button role="menuitem" data-testid="site-menu-design-relire" onclick={() => choisir(() => api.design.relire())}>Relire ce projet</button>
    </span>
  {/if}
  <button
    class="bouton"
    data-testid="site-bouton-design"
    aria-label="Mode design"
    aria-pressed={actif}
    disabled={indisponible}
    title={indisponible ? (design?.indisponible ?? "") : "Mode design (⌘⇧D)"}
    onclick={() => api.design.basculer()}
    >✎{#if design && design.panier > 0}<span class="compteur" data-testid="site-compteur-panier">{design.panier}</span>{/if}</button
  >
  <!-- Always active: the basket and the review stay reachable where the mode does not start (home, card…). -->
  <button class="chevron" data-testid="site-menu-design" aria-label="Menu du mode design" aria-expanded={menuOuvert} onclick={() => (menuOuvert = !menuOuvert)}>▾</button>
</span>

<style>
  .design { display: inline-flex; align-items: center; gap: 2px; flex: none; -webkit-app-region: no-drag; }
  .entrees { display: inline-flex; gap: 2px; margin-right: 4px; }
  button { all: unset; height: 24px; display: grid; grid-auto-flow: column; align-items: center; gap: 3px; border-radius: 5px; color: var(--texte-doux); cursor: pointer; white-space: nowrap; -webkit-app-region: no-drag; }
  .entrees button { padding: 0 8px; font-size: 12px; background: var(--fond-actif); color: var(--texte); }
  .bouton { padding: 0 6px; }
  .chevron { width: 14px; justify-content: center; font-size: 10px; }
  button:hover:not(:disabled) { background: var(--fond-survol); color: var(--texte); }
  button:disabled { opacity: 0.35; cursor: default; }
  .bouton[aria-pressed="true"] { color: var(--accent); }
  .chevron[aria-expanded="true"] { background: var(--fond-survol); color: var(--texte); }
  .compteur { min-width: 14px; padding: 0 3px; box-sizing: border-box; border-radius: 7px; background: var(--accent); color: #fff; font-size: 10px; line-height: 14px; text-align: center; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
