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

  /**
   * La souris ne choisit une carte qu'après un vrai mouvement : le panneau qui apparaît (ou change de cartes) sous une
   * souris immobile ne doit pas voler la sélection du clavier. Chromium envoie alors des déplacements à la même place.
   */
  let place: { x: number; y: number } | null = null;
  /** Le déplacement en cours de traitement a vraiment bougé (noté en capture, avant la carte). */
  let bouge = false;
  const noterPlace = (e: PointerEvent) => {
    bouge = !!place && (place.x !== e.screenX || place.y !== e.screenY);
    place = { x: e.screenX, y: e.screenY };
  };
</script>

<!-- En capture : le panneau passe avant tout le reste (modale, historique…), et Échap ne ferme que lui. -->
<svelte:window
  onpointermovecapture={noterPlace}
  onkeyup={(e) => {
    // Redondant avec le `before-input-event` de l'interface (sans effet hors parcours) : le panneau ne reste jamais bloqué.
    if (e.key === "Control") envoyer({ type: "valider" });
  }}
  onkeydowncapture={(e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
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
      onpointermove={() => bouge && i !== panneau.selection && envoyer({ type: "survoler", id: carte.id })}
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
    /* Au-dessus des modales (100) : une demande de l'agent arrivée pendant le parcours ne le couvre pas. */
    z-index: 101;
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
