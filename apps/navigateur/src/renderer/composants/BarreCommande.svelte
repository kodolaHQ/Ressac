<script lang="ts">
  import { tick } from "svelte";
  import type { EtatFenetre, Onglet } from "../../commun/modele";
  import { api } from "../etat.svelte";
  import { fermerCommande, commande } from "./commande.svelte";
  import { lignesCommande, type LigneCommande, type SourcesCommande } from "./commande";

  /**
   * Barre de commande (⌘T, ⌘L) : une boîte au-dessus de la page figée et floutée (FondFige, monté par App). Le champ est
   * monté tout de suite : la frappe qui suit le raccourci n'attend pas la capture.
   */
  let { fenetre, ongletActif }: { fenetre: EtatFenetre; ongletActif: Onglet | undefined } = $props();

  // Les sources viennent d'ici (actions, onglets, applis, historique) : une seule déclaration à remplir.
  const sources: SourcesCommande = { actions: [], onglets: [], applis: [], historique: [] };

  let texte = $state("");
  let choisie = $state(0);
  let champ: HTMLInputElement;

  const mode = $derived(commande.ouverte?.mode ?? "nouveau");
  const lignes: LigneCommande[] = $derived(lignesCommande(texte, sources, mode === "actif" ? (ongletActif?.url ?? null) : null));

  // À chaque ouverture (la première, ou une réouverture dans l'autre mode) : saisie de départ, tout sélectionné en mode « actif ».
  $effect(() => {
    const o = commande.ouverte;
    if (!o) return;
    texte = o.texte;
    choisie = 0;
    void tick().then(() => {
      champ?.focus();
      if (o.mode === "actif") champ?.select();
    });
  });

  /** Seule fonction qui agit : une ligne choisie (Entrée ou clic). */
  function executer(l: LigneCommande) {
    const cible = mode === "actif" ? (ongletActif?.id ?? null) : null;
    if (l.type === "defaut" && l.texte === "") {
      // Accueil : depuis un onglet (ou sous un panneau de l'interface) on y revient ; sinon on y est déjà.
      if (ongletActif || document.querySelector('[data-testid="page-vide"]') === null) {
        api.agir({ type: "afficherPageVide", fenetreId: fenetre.id });
      }
      fermerCommande();
      // L'accueil garde le clavier dans son champ.
      void tick().then(() => document.querySelector<HTMLInputElement>('[data-testid="saisie-page-vide"]')?.focus());
      return;
    }
    if (l.type === "defaut") api.naviguer(cible, l.texte);
    else if (l.type === "historique") api.naviguer(cible, l.url);
    else return; // les autres types : branchés avec leurs sources
    fermerCommande(true);
  }

  function touche(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      choisie = (choisie + 1) % lignes.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      choisie = (choisie - 1 + lignes.length) % lignes.length;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const l = lignes[choisie];
      if (l) executer(l);
    }
  }

  const libelle = (l: LigneCommande): string =>
    l.type === "defaut" ? l.libelle : l.type === "action" ? l.nom : l.type === "onglet" ? l.onglet.titre : l.type === "appli" ? l.appli.nom : l.titre || l.url;
  const detail = (l: LigneCommande): string => (l.type === "onglet" ? l.onglet.url : l.type === "historique" ? l.url : "");
</script>

<!-- En capture : la barre passe avant tout le reste (modale, historique…), et Échap ne ferme qu'elle. -->
<svelte:window
  onblur={() => fermerCommande()}
  onkeydowncapture={(e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    fermerCommande(true);
  }}
/>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fond" onclick={(e) => e.target === e.currentTarget && fermerCommande(true)}>
  <div class="boite" data-testid="barre-commande" role="dialog" aria-label="Barre de commande">
    <input
      bind:this={champ}
      bind:value={texte}
      oninput={() => (choisie = 0)}
      onkeydown={touche}
      data-testid="saisie-commande"
      placeholder="Rechercher ou saisir une adresse"
      spellcheck="false"
      autocomplete="off"
    />
    <ul role="listbox">
      {#each lignes as l, i (i)}
        <li role="option" aria-selected={i === choisie} data-testid="ligne-commande" data-type={l.type}>
          <button type="button" tabindex="-1" class:choisie={i === choisie} onmousemove={() => (choisie = i)} onclick={() => executer(l)}>
            <span class="libelle">{libelle(l)}</span>
            {#if detail(l)}<span class="detail">{detail(l)}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .fond { position: fixed; inset: 0; z-index: 100; display: flex; justify-content: center; align-items: flex-start; padding: 14vh 16px 0; -webkit-app-region: no-drag; }
  .boite {
    width: min(640px, 100%);
    max-height: 70vh;
    overflow-y: auto;
    padding: 8px;
    background: var(--fond-actif);
    color: var(--texte);
    border: 1px solid var(--bord);
    border-radius: 12px;
    box-shadow: var(--ombre-modale);
    font-size: 14px;
  }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; font: inherit; font-size: 16px; color: var(--texte); background: var(--fond); border: 1px solid var(--bord); border-radius: 8px; outline: none; }
  input:focus { border-color: var(--accent); }
  ul { list-style: none; margin: 6px 0 0; padding: 0; }
  button { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 7px 10px; border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  button.choisie { background: var(--fond); }
  .libelle { flex: none; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.6; font-size: 12px; }
</style>
