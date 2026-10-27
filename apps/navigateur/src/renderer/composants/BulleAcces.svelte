<script lang="ts">
  import type { DroitDev, EtatAccesOnglet } from "@webaios/noyau";
  import { acces, api } from "../etat.svelte";

  let { id, etat, ancre }: { id: string; etat: EtatAccesOnglet; ancre: HTMLElement } = $props();

  const LARGEUR = 260;
  const DROITS: Record<DroitDev, { icone: string; nom: string }> = {
    console: { icone: "👁", nom: "Console et erreurs" },
    reseau: { icone: "👁", nom: "Réseau" },
    performances: { icone: "👁", nom: "Performances et mémoire" },
    agir: { icone: "⚡", nom: "Agir sur la page" },
  };

  // Posée sous la pastille, sans sortir de la fenêtre ; fixe pour ne pas être rognée par la liste d'onglets.
  const place = $derived.by(() => {
    const r = ancre.getBoundingClientRect();
    return { left: Math.max(8, Math.min(r.right - LARGEUR, window.innerWidth - LARGEUR - 8)), top: r.bottom + 6 };
  });
</script>

<div class="bulle" data-testid="bulle-acces" role="dialog" aria-label="Accès de l'agent" style:left="{place.left}px" style:top="{place.top}px" style:width="{LARGEUR}px">
  <h4>{acces.agent} a accès à cet onglet</h4>
  <ul>
    {#if etat.lecture}
      <li data-ligne="lecture"><span>👁 Lecture de la page</span></li>
    {/if}
    {#each etat.droits as d (d)}
      <li data-ligne={d}>
        <span>{DROITS[d].icone} {DROITS[d].nom}</span>
        <button class="couper-droit" data-droit={d} onclick={() => api.acces.couper(id, d)}>Couper</button>
      </li>
    {/each}
  </ul>
  <p>Cette conversation · tombe si l'onglet change de site</p>
  <button class="couper" onclick={() => api.acces.couper(id)}>Couper l'accès</button>
</div>

<style>
  .bulle { position: fixed; z-index: 30; box-sizing: border-box; padding: 10px; background: var(--fond-actif); color: var(--texte); border: 1px solid var(--bord); border-radius: 9px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); font-size: 12px; font-weight: 400; cursor: default; text-align: left; }
  h4 { margin: 0 0 6px; font-size: 12px; }
  ul { list-style: none; margin: 0 0 6px; padding: 0; }
  li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; }
  p { margin: 0 0 8px; color: var(--texte-doux); font-size: 11.5px; }
  button { padding: 3px 9px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-barre); color: var(--texte); font-size: 11.5px; font-weight: 600; }
  button:hover { background: var(--fond-survol); }
  .couper { display: block; width: 100%; padding: 5px; background: #c2410c; border-color: #c2410c; color: white; font-size: 12px; }
  .couper:hover { background: #ea580c; }
</style>
