<script lang="ts">
  import Icone from "./Icone.svelte";
  import type { Placement, WidgetAffiche } from "../../commun/api";
  import { api } from "../etat.svelte";

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
    /** Ouvre la page « Voir le workflow » du widget. */
    voirWorkflow: () => void;
  } = $props();

  const date = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "date inconnue";

  let iframe = $state<HTMLIFrameElement>();
  let largeur = $state(0);
  let hauteur = $state(0);
  let menuOuvert = $state(false);

  function envoyer() {
    if ("erreur" in widget) return;
    // Le cadre a une origine opaque (sandbox sans allow-same-origin) : « * » est la seule cible possible.
    iframe?.contentWindow?.postMessage(
      {
        type: "widget",
        donnees: $state.snapshot(widget.donnees ?? widget.exemple),
        taille: { l: placement.l, h: placement.h },
        px: { largeur, hauteur },
        etat: { statut: widget.etat.statut, derniereMaj: widget.etat.derniereMaj },
      },
      "*",
    );
  }
  // À chaque changement de données, d'état ou de taille (le chargement passe par onload).
  $effect(() => {
    if ("erreur" in widget) return;
    void [widget.donnees, widget.exemple, widget.etat.statut, widget.etat.derniereMaj, placement.l, placement.h, largeur, hauteur];
    envoyer();
  });

  function surMessage(e: MessageEvent) {
    if (!iframe || e.source !== iframe.contentWindow) return;
    const d: unknown = e.data;
    if (typeof d !== "object" || d === null) return;
    const { type, url } = d as { type?: unknown; url?: unknown };
    if (type !== "ouvrir" || typeof url !== "string") return;
    // Le process principal n'ouvre le lien que si un vrai clic de l'utilisateur vient de tomber dans ce widget (un lien par clic).
    api.accueil.ouvrir(url, widget.id);
  }

  function poignee(e: PointerEvent) {
    if (e.target instanceof Element && e.target.closest("button")) return;
    menuOuvert = false;
    commencer("deplacer", e);
  }
</script>

<svelte:window onmessage={surMessage} />

<article class="widget" class:geste data-testid="widget-{widget.id}">
  <!-- L'en-tête sert de poignée de déplacement : le cadre du widget avale les événements de la souris. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header onpointerdown={poignee}>
    {#if "erreur" in widget}
      <p class="illisible">Widget « {widget.id} » illisible : {widget.erreur}</p>
    {:else}
      <h2 data-testid="titre-widget">{widget.nom}</h2>
      {#if widget.etat.statut === "en-cours"}
        <span class="badge">mise à jour…</span>
      {:else if widget.etat.statut === "erreur"}
        <span class="badge echec" title={widget.etat.journal ?? ""}
          >échec du {date(widget.etat.derniereTentative)} : {widget.etat.erreur ?? "erreur inconnue"}</span
        >
      {:else if widget.etat.statut === "atelier-arrete"}
        <span class="badge echec">mise à jour impossible : atelier arrêté</span>
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
              <button role="menuitem" onclick={() => ((menuOuvert = false), voirWorkflow())}>Voir le workflow</button>
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
    <div class="contenu" bind:clientWidth={largeur} bind:clientHeight={hauteur}>
      {#if widget.src}
        <!-- Sans allow-same-origin : le code écrit par l'agent tourne dans une origine opaque, sans accès à l'interface. -->
        <iframe bind:this={iframe} src={widget.src} title={widget.nom} sandbox="allow-scripts" onload={envoyer}></iframe>
      {:else}
        <p class="vide">L'agent n'a pas encore écrit l'affichage de ce widget.</p>
      {/if}
    </div>
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
  .contenu { flex: 1; min-height: 0; display: flex; }
  iframe { flex: 1; width: 100%; height: 100%; border: none; background: white; }
  .geste iframe { pointer-events: none; }
  .vide { margin: 0; padding: 8px 12px; font-size: 12px; color: var(--texte-doux); }
  .poignee-taille { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; z-index: 2;
    background: linear-gradient(135deg, transparent 50%, var(--texte-doux) 50%, var(--texte-doux) 60%, transparent 60%, transparent 75%, var(--texte-doux) 75%, var(--texte-doux) 85%, transparent 85%); }
</style>
