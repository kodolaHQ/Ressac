<script lang="ts">
  import type { EtatDesign } from "../shared/api";
  import { acces, accesDe } from "./acces.svelte";
  import PastilleAcces from "./composants/PastilleAcces.svelte";

  /** `app:<dossier>` : l'unique id dont cette vue montre l'accès. */
  let { id }: { id: string } = $props();
  const etat = $derived(accesDe(id));
  const api = window.webaios as unknown as import("../shared/api").ApiPastille;
  let menuOuvert = $state(false);
  let design = $state<EtatDesign | null>(null);
  let racine = $state<HTMLElement>();
  // La vue grandit tant que la bulle ou le menu est ouvert, et ne gêne l'appli que pendant ce temps.
  $effect(() => api.pastilleTaille(acces.bullesOuvertes > 0 || menuOuvert));

  async function basculerMenu() {
    menuOuvert = !menuOuvert;
    if (menuOuvert) design = await api.design.etat().catch(() => null);
  }
  function choisir(agir: () => void) {
    menuOuvert = false;
    agir();
  }
  function dehors(e: PointerEvent) {
    if (menuOuvert && !racine?.contains(e.target as Node)) menuOuvert = false;
  }
</script>

<svelte:window onpointerdown={dehors} onblur={() => (menuOuvert = false)} onkeydown={(e) => e.key === "Escape" && (menuOuvert = false)} />

<main>
  <div class="ligne">
    {#if etat}<PastilleAcces {id} {etat} />{/if}
    <span class="webaios" bind:this={racine}>
      <button class="pastille" data-testid="pastille-webaios" aria-label="WebAiOs" aria-haspopup="menu" aria-expanded={menuOuvert} onclick={basculerMenu}>✎</button>
      {#if menuOuvert}
        <div class="menu" role="menu">
          <button role="menuitem" class:actif={design?.actif} onclick={() => choisir(() => api.design.basculer())}>Mode design <kbd>⌘⇧D</kbd></button>
          <button role="menuitem" onclick={() => choisir(() => api.design.panier())}>Panier ({design?.panier ?? 0})</button>
          <button role="menuitem" onclick={() => choisir(() => api.design.relire())}>Relire ce projet</button>
        </div>
      {/if}
    </span>
  </div>
</main>

<style>
  main { display: flex; justify-content: flex-end; align-items: flex-start; height: 100%; }
  .ligne { display: flex; align-items: center; gap: 6px; height: 28px; }
  .webaios { position: relative; display: inline-flex; }
  .pastille { all: unset; display: grid; place-content: center; width: 40px; height: 24px; border-radius: 999px; background: var(--fond-actif); color: var(--texte); font-size: 12px; cursor: pointer; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35); }
  .pastille[aria-expanded="true"] { color: var(--accent); }
  .menu { position: absolute; right: 0; top: 30px; width: 200px; padding: 4px; background: var(--fond-actif); border: 1px solid var(--bord); border-radius: 6px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35); }
  .menu button { all: unset; display: flex; justify-content: space-between; box-sizing: border-box; width: 100%; padding: 5px 6px; border-radius: 4px; color: var(--texte); cursor: pointer; font-size: 13px; }
  .menu button:hover { background: var(--fond-survol); }
  .menu button.actif { color: var(--accent); }
  kbd { font: inherit; color: var(--texte-doux); }
</style>
