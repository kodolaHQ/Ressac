<script lang="ts">
  import { api } from "../etat.svelte";
  import { design } from "./design.svelte";
  import { ouvrirMenu, type EntreeMenu } from "./menu.svelte";

  const e = $derived(design.etat);
  const indisponible = $derived(!e || e.indisponible !== null);

  function menu(ev: MouseEvent) {
    const entrees: EntreeMenu[] = [{ libelle: "Panier", agir: () => (design.panierDemande = true) }];
    // Task 11: the review of the agent's apps and external projects.
    if (e?.projet && e.projet.type !== "demo") entrees.push({ libelle: "Relire ce projet", agir: () => api.design.relire() });
    ouvrirMenu(ev, entrees);
  }
</script>

<span class="design">
  <button
    class="bouton"
    data-testid="bouton-design"
    aria-label="Mode design"
    aria-pressed={e?.actif ?? false}
    disabled={indisponible}
    title={indisponible ? (e?.indisponible ?? "") : "Mode design (⌘⇧D)"}
    onclick={() => api.design.basculer()}
    >✎{#if e && e.panier > 0}<span class="compteur" data-testid="compteur-panier">{e.panier}</span>{/if}</button
  >
  <button class="chevron" aria-label="Menu du mode design" disabled={indisponible} onclick={menu}>▾</button>
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
