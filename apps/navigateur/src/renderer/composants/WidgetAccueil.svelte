<script lang="ts">
  import CadreWidget from "./CadreWidget.svelte";
  import Icone from "./Icone.svelte";
  import { prochaineExecution } from "./prochaine";
  import type { Placement, WidgetAffiche } from "../../commun/api";

  let {
    widget,
    placement,
    geste,
    avertissement,
    refuse,
    commencer,
    retirer,
    autoriser,
    refuser,
    recolter,
    voirWorkflow,
  }: {
    widget: WidgetAffiche;
    /** La place affichée (celle de l'aperçu pendant un glisser). */
    placement: Placement;
    /** Un glisser ou un redimensionnement est en cours sur la grille : le cadre ne capte pas la souris. */
    geste: boolean;
    /** L'action demandée n'a rien changé (service des widgets absent…). */
    avertissement: string | null;
    /** L'utilisateur a refusé la lecture avec son compte : le bandeau ne revient pas. */
    refuse: boolean;
    commencer: (mode: "deplacer" | "taille", e: PointerEvent) => void;
    retirer: () => void;
    autoriser: () => void;
    refuser: () => void;
    recolter: () => void;
    /** Ouvre le constructeur du workflow du widget. */
    voirWorkflow: () => void;
  } = $props();

  const date = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "date inconnue";

  let menuOuvert = $state(false);

  /** Relue chaque minute : « prochaine : … » passe d'aujourd'hui à demain sans attendre un changement du widget. */
  let maintenant = $state(new Date());
  $effect(() => {
    const minuterie = setInterval(() => (maintenant = new Date()), 60_000);
    return () => clearInterval(minuterie);
  });
  const prochaine = $derived("erreur" in widget ? null : prochaineExecution(widget.heures, maintenant));

  function poignee(e: PointerEvent) {
    if (e.target instanceof Element && e.target.closest("button")) return;
    menuOuvert = false;
    commencer("deplacer", e);
  }
</script>

<article class="widget" class:geste data-testid="widget-{widget.id}">
  <!-- L'en-tête sert de poignée de déplacement : le cadre du widget avale les événements de la souris. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header onpointerdown={poignee}>
    {#if "erreur" in widget}
      <p class="illisible">Widget « {widget.id} » illisible : {widget.erreur}</p>
    {:else}
      <h2 data-testid="titre-widget">{widget.nom}</h2>
      {#if widget.etat.statut === "en-cours"}
        {#if widget.etat.progression}
          <span class="badge" data-testid="progression">mise à jour… {widget.etat.progression.faits} / {widget.etat.progression.total}</span>
        {:else}
          <span class="badge">mise à jour…</span>
        {/if}
      {:else if widget.etat.statut === "erreur"}
        <span class="badge echec" title={widget.etat.journal ?? ""}
          >échec du {date(widget.etat.derniereTentative)} : {widget.etat.erreur ?? "erreur inconnue"}</span
        >
      {:else if widget.etat.statut === "atelier-arrete"}
        <span class="badge echec">mise à jour impossible : atelier arrêté</span>
      {:else if prochaine}
        <span class="badge doux" data-testid="prochaine">prochaine : {prochaine}</span>
      {/if}
    {/if}
    <div class="actions">
      <button class="menu" aria-label="Options du widget" title="Options du widget" onclick={() => (menuOuvert = !menuOuvert)}>
        <Icone nom="options" taille={14} />
      </button>
      {#if menuOuvert}
        <div class="liste" role="menu">
          {#if !("erreur" in widget)}
            <button role="menuitem" onclick={() => ((menuOuvert = false), recolter())}>Mettre à jour maintenant</button>
            {#if widget.aRecolte}
              <button role="menuitem" onclick={() => ((menuOuvert = false), voirWorkflow())}>Voir / modifier le workflow</button>
            {/if}
          {/if}
          <button role="menuitem" onclick={() => ((menuOuvert = false), retirer())}>Retirer</button>
        </div>
      {/if}
    </div>
  </header>
  {#if !("erreur" in widget)}
    {#if widget.etat.statut === "accord-requis" && !refuse}
      <div class="bandeau" data-testid="bandeau-accord">
        <span
          >Ce widget veut lire {widget.compte.join(", ")} avec ton compte{#if widget.publiques.length}, et pourra contacter : {widget.publiques.join(", ")}{:else}, et ne contactera aucun autre site{/if}.</span
        >
        <button onclick={autoriser}>Autoriser…</button>
        <button onclick={refuser}>Refuser</button>
      </div>
    {/if}
    {#if avertissement}<p class="avertissement">{avertissement}</p>{/if}
    <CadreWidget
      {widget}
      donnees={widget.donnees ?? widget.exemple}
      taille={{ l: placement.l, h: placement.h }}
      etat={{ statut: widget.etat.statut, derniereMaj: widget.etat.derniereMaj }}
    />
  {:else if avertissement}
    <p class="avertissement">{avertissement}</p>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="poignee-taille" data-testid="poignee-taille" title="Redimensionner" onpointerdown={(e) => ((menuOuvert = false), commencer("taille", e))}></div>
</article>

<style>
  .widget { position: relative; display: flex; flex-direction: column; height: 100%; box-sizing: border-box; border: 1px solid var(--bord); border-radius: 10px; background: var(--fond-barre); overflow: hidden; }
  header { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; cursor: grab; user-select: none; min-height: 20px; }
  h2 { margin: 0; font-size: 13px; font-weight: 600; color: var(--texte); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: 11px; color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .badge.doux { color: var(--texte-doux); }
  .badge.echec, .illisible, .avertissement { color: var(--en-erreur); }
  .illisible { margin: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
  .actions { position: relative; margin-left: auto; }
  .menu { all: unset; width: 22px; height: 22px; display: grid; place-content: center; border-radius: 4px; color: var(--texte-doux); cursor: pointer; }
  .menu:hover { background: var(--fond-survol); }
  .liste { position: absolute; right: 0; top: 24px; z-index: 3; display: flex; flex-direction: column; min-width: 190px; padding: 4px; border-radius: 8px; border: 1px solid var(--bord); background: var(--fond-barre); box-shadow: var(--ombre-modale); }
  .liste button { all: unset; padding: 6px 10px; border-radius: 4px; font-size: 13px; color: var(--texte); cursor: pointer; }
  .liste button:hover { background: var(--fond-survol); }
  .bandeau { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12px; color: var(--texte); background: var(--fond-survol); }
  .bandeau button { padding: 3px 10px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond); color: var(--texte); font-size: 12px; cursor: pointer; }
  .bandeau button:first-of-type { background: var(--accent); border-color: var(--accent); color: white; }
  .avertissement { margin: 0; padding: 4px 12px; font-size: 12px; }
  /* Pendant un glisser, le cadre (dans CadreWidget) ne capte pas la souris. */
  .geste :global(iframe) { pointer-events: none; }
  .poignee-taille { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; z-index: 2;
    background: linear-gradient(135deg, transparent 50%, var(--texte-doux) 50%, var(--texte-doux) 60%, transparent 60%, transparent 75%, var(--texte-doux) 75%, var(--texte-doux) 85%, transparent 85%); }
</style>
