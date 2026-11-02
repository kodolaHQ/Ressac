<script lang="ts">
  import type { PanneauOnglets } from "../../commun/api";
  import { api } from "../etat.svelte";
  import IconeSite from "./IconeSite.svelte";

  /**
   * Panneau ⌃Tab : les onglets récents en cartes d'aperçu, la sélection entourée. Le process principal tient le parcours
   * (ordre, sélection, relâchement de ⌃) ; le panneau ne fait que l'afficher et lui renvoyer souris, Échap et ⌃ relâché.
   */
  let { panneau }: { panneau: PanneauOnglets } = $props();

  const envoyer = api.parcoursOnglets;
</script>

<svelte:window
  onkeyup={(e) => {
    // Redondant avec le `before-input-event` de l'interface (sans effet hors parcours) : le panneau ne reste jamais bloqué.
    if (e.key === "Control") envoyer({ type: "valider" });
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      envoyer({ type: "annuler" });
    }
    // ⌃Tab et ⌃⇧Tab : l'accélérateur du menu avance déjà le parcours, interface au focus comprise. Rien à envoyer ici
    // (ce serait un double pas), et surtout pas de preventDefault : une touche consommée par la page n'atteint plus le menu.
  }}
/>

<div class="panneau" data-testid="panneau-onglets" role="listbox" aria-label="Onglets récents">
  {#each panneau.cartes as carte, i (carte.id)}
    <div
      class="carte"
      data-testid="carte-onglet"
      role="option"
      tabindex="-1"
      aria-selected={i === panneau.selection}
      title={carte.titre}
      onmouseenter={() => i !== panneau.selection && envoyer({ type: "survoler", id: carte.id })}
      onclick={() => envoyer({ type: "choisir", id: carte.id })}
    >
      <div class="apercu">
        {#if carte.apercu}
          <img src={carte.apercu} alt="" />
        {:else}
          <div class="secours"><IconeSite favicon={carte.favicon} titre={carte.titre} taille={40} /></div>
        {/if}
      </div>
      <div class="legende">
        <IconeSite favicon={carte.favicon} titre={carte.titre} />
        <span class="titre">{carte.titre}</span>
      </div>
    </div>
  {/each}
</div>

<style>
  .panneau {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 16px;
    -webkit-app-region: no-drag;
  }
  .carte {
    flex: 0 1 200px;
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
  .legende { display: flex; align-items: center; gap: 6px; margin-top: 7px; font-size: 12.5px; }
  .titre { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
