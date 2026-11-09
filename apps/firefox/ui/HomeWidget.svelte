<script lang="ts">
  import type { ShownWidget } from "../shared/api";
  import type { FreePlacement } from "../../../packages/kernel/src/home/schemas";
  import WidgetFrame from "./WidgetFrame.svelte";
  import Icon from "./components/Icon.svelte";
  import { nextRun } from "./components/next";
  import { freeUnits } from "./free-grid";

  let {
    widget,
    placement,
    gesture: gesture,
    warning: warning,
    denied: denied,
    start: commencer,
    remove: remove,
    allow: allow,
    deny: deny,
    harvest: harvest,
    viewWorkflow: seeWorkflow,
  }: {
    widget: ShownWidget;
    /** The place shown (the preview's during a drag). */
    placement: FreePlacement;
    /** A drag or resize is under way on the grid: the frame does not capture the mouse. */
    gesture: boolean;
    /** The requested action changed nothing (widget service missing…). */
    warning: string | null;
    /** The user refused the read with their account: the banner does not come back. */
    denied: boolean;
    start: (mode: "deplacer" | "taille", e: PointerEvent) => void;
    remove: () => void;
    allow: () => void;
    deny: () => void;
    harvest: () => void;
    viewWorkflow: () => void;
  } = $props();

  const date = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "date inconnue";

  let menuOpen = $state(false);

  /** Re-read every minute: « prochaine : … » goes from today to tomorrow without waiting for a widget change. */
  let now = $state(new Date());
  $effect(() => {
    const timer = setInterval(() => (now = new Date()), 60_000);
    return () => clearInterval(timer);
  });
  // Never for a widget waiting for the user's grant: nothing goes out without them.
  const next = $derived(
    "error" in widget || widget.state.status === "accord-requis"
      ? null
      : nextRun(
          widget.hours,
          now,
          widget.minutes !== null ? { minutes: widget.minutes, lastUpdate: widget.state.lastUpdate } : undefined,
          widget.state,
        ),
  );

  // The real size becomes the grid units the display receives in postMessage.
  const size = $derived(freeUnits({ l: placement.l, h: placement.h }));

  function handle(e: PointerEvent) {
    if (e.target instanceof Element && e.target.closest("button")) return;
    menuOpen = false;
    commencer("deplacer", e);
  }
</script>

<article class="widget" class:geste={gesture} data-testid="widget-{widget.id}">
  <!-- The header is the drag handle: the widget's frame swallows the mouse events. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header onpointerdown={handle}>
    {#if "error" in widget}
      <p class="illisible">Widget « {widget.id} » illisible : {widget.error}</p>
    {:else}
      <h2 data-testid="titre-widget">{widget.name}</h2>
      {#if widget.state.status === "en-cours"}
        {#if widget.state.progress}
          <span class="badge" data-testid="progression">mise à jour… {widget.state.progress.done} / {widget.state.progress.total}</span>
        {:else}
          <span class="badge">mise à jour…</span>
        {/if}
      {:else if widget.state.status === "erreur"}
        <span class="badge echec" title={widget.state.log ?? ""}
          >échec du {date(widget.state.lastAttempt)} : {widget.state.error ?? "erreur inconnue"}</span
        >
      {:else if widget.state.status === "atelier-arrete"}
        <span class="badge echec">mise à jour impossible : atelier arrêté</span>
      {:else if next}
        <span class="badge doux" data-testid="prochaine">prochaine : {next}</span>
      {/if}
    {/if}
    <div class="actions">
      <button class="menu" aria-label="Options du widget" title="Options du widget" onclick={() => (menuOpen = !menuOpen)}>
        <Icon name="options" size={14} />
      </button>
      {#if menuOpen}
        <div class="liste" role="menu">
          {#if !("error" in widget)}
            <button role="menuitem" onclick={() => ((menuOpen = false), harvest())}>Mettre à jour maintenant</button>
            {#if widget.hasHarvest}
              <button role="menuitem" onclick={() => ((menuOpen = false), seeWorkflow())}>Voir / modifier le workflow</button>
            {/if}
          {/if}
          <button role="menuitem" onclick={() => ((menuOpen = false), remove())}>Retirer</button>
        </div>
      {/if}
    </div>
  </header>
  {#if !("error" in widget)}
    {#if widget.state.status === "accord-requis" && !denied}
      <div class="bandeau" data-testid="bandeau-accord">
        <span
          >Ce widget veut lire {widget.account.join(", ")} avec ton compte{#if widget.public.length}, et pourra contacter : {widget.public.join(", ")}{:else}, et ne contactera aucun autre site{/if}.</span
        >
        <button onclick={allow}>Autoriser…</button>
        <button onclick={deny}>Refuser</button>
      </div>
    {/if}
    {#if warning}<p class="avertissement">{warning}</p>{/if}
    <WidgetFrame
      {widget}
      data={widget.data ?? widget.example}
      size={size}
      state={{ status: widget.state.status, lastUpdate: widget.state.lastUpdate }}
    />
  {:else if warning}
    <p class="avertissement">{warning}</p>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="poignee-taille" data-testid="poignee-taille" title="Redimensionner" onpointerdown={(e) => ((menuOpen = false), commencer("taille", e))}></div>
</article>

<style>
  .widget {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    box-sizing: border-box;
    border: 1px solid var(--accueil-bord);
    border-radius: var(--accueil-rayon);
    background: var(--accueil-carte);
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.12);
    overflow: hidden;
    color: var(--accueil-texte);
  }
  /* Softer shadow on a light background. */
  @media (prefers-color-scheme: light) {
    .widget { box-shadow: 0 1px 6px rgb(0 0 0 / 0.08); }
  }
  header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: grab; user-select: none; min-height: 20px; }
  h2 { margin: 0; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: 11px; color: var(--accueil-accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .badge.doux { color: var(--accueil-texte-doux); }
  .badge.echec, .illisible, .avertissement { color: var(--en-erreur); }
  .illisible { margin: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
  .actions { position: relative; margin-left: auto; }
  .menu { all: unset; width: 22px; height: 22px; display: grid; place-content: center; border-radius: 4px; color: var(--accueil-texte-doux); cursor: pointer; }
  .menu:hover { background: var(--fond-survol); }
  .liste { position: absolute; right: 0; top: 24px; z-index: 3; display: flex; flex-direction: column; min-width: 190px; padding: 4px; border-radius: 8px; border: 1px solid var(--accueil-bord); background: var(--accueil-carte); box-shadow: var(--ombre-modale); }
  .liste button { all: unset; padding: 6px 10px; border-radius: 4px; font-size: 13px; color: var(--accueil-texte); cursor: pointer; }
  .liste button:hover { background: var(--fond-survol); }
  .bandeau { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12px; background: var(--fond-survol); }
  .bandeau button { padding: 3px 10px; border-radius: 6px; border: 1px solid var(--accueil-bord); background: var(--accueil-fond); color: var(--accueil-texte); font-size: 12px; cursor: pointer; }
  .bandeau button:first-of-type { background: var(--accueil-accent); border-color: var(--accueil-accent); color: white; }
  .avertissement { margin: 0; padding: 4px 12px; font-size: 12px; }
  /* During a drag, the frame (in WidgetFrame) does not capture the mouse. */
  .geste :global(iframe) { pointer-events: none; }
  /* The handle only shows on card hover (the most sober look). */
  .poignee-taille { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; z-index: 2; opacity: 0;
    background: linear-gradient(135deg, transparent 50%, var(--accueil-texte-doux) 50%, var(--accueil-texte-doux) 60%, transparent 60%, transparent 75%, var(--accueil-texte-doux) 75%, var(--accueil-texte-doux) 85%, transparent 85%); }
  .widget:hover .poignee-taille { opacity: 1; }
</style>
