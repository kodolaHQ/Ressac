<script lang="ts">
  import { untrack } from "svelte";
  import type { DroitDev, EtatAccesOnglet } from "@webaios/noyau";
  import { acces, api } from "../etat.svelte";

  let { id, etat, ancre }: { id: string; etat: EtatAccesOnglet; ancre: HTMLElement } = $props();

  const MARGE = 8;
  const DROITS: Record<DroitDev, { icone: string; nom: string }> = {
    console: { icone: "👁", nom: "Console et erreurs" },
    reseau: { icone: "👁", nom: "Réseau" },
    performances: { icone: "👁", nom: "Performances et mémoire" },
    agir: { icone: "⚡", nom: "Agir sur la page" },
  };

  // La page web (une vue native) couvre toujours l'interface : la bulle reste dans la colonne de la barre latérale,
  // sous la pastille, et ne dépasse pas le bas de la fenêtre. Elle se replace si la fenêtre change de taille.
  /** Déplace la bulle sous <body> : un ancêtre transformé ou rogné ferait de lui son repère `fixed`. */
  function souscorps(noeud: HTMLElement) {
    document.body.append(noeud);
    noeud.focus(); // le clavier (Échap) vise l'interface, pas la page
    return { destroy: () => noeud.remove() };
  }
  let hauteur = $state(0);
  let fenetreW = $state(window.innerWidth);
  let fenetreH = $state(window.innerHeight);
  const place = $derived.by(() => {
    void fenetreW;
    void fenetreH;
    const colonne = ancre.closest("aside")?.getBoundingClientRect();
    const r = ancre.getBoundingClientRect();
    const gauche = (colonne?.left ?? 0) + MARGE;
    const largeur = Math.max(120, (colonne?.width ?? 240) - 2 * MARGE);
    return { left: gauche, width: largeur, top: Math.max(MARGE, Math.min(r.bottom + 6, fenetreH - hauteur - MARGE)) };
  });
  $effect(() => {
    // Lu puis écrit : sans untrack, l'effet se relancerait lui-même.
    untrack(() => acces.bullesOuvertes++);
    return () => untrack(() => acces.bullesOuvertes--);
  });
</script>

<svelte:window bind:innerWidth={fenetreW} bind:innerHeight={fenetreH} />

<div class="bulle" tabindex="-1" use:souscorps bind:clientHeight={hauteur} data-testid="bulle-acces" role="dialog" aria-label="Accès de l'agent" style:left="{place.left}px" style:top="{place.top}px" style:width="{place.width}px">
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
