<script lang="ts">
  import { untrack } from "svelte";
  import type { ShownWidget } from "../shared/api";
  import { api } from "../ui/etat.svelte";
  import { GAP_PX, ROW_PX } from "../ui/grille";
  import { previewData } from "../ui/constructeur/apercu";
  import type { Executions } from "../ui/constructeur/executions.svelte";
  import CadreWidget from "./CadreWidget.svelte";
  import { freeUnits } from "./grille-libre";

  /**
   * The floating preview of the widget as the home page shows it (same isolated frame), with
   * the chosen run's data. The Firefox home places widgets freely: its placement is turned back into grid units.
   */
  let { id, executions }: { id: string; executions: Executions } = $props();

  /** Width of a home column at its maximum width (1200 px, 12 columns). */
  const COLUMN_PX = 89;
  let widget = $state.raw<ShownWidget | null>(null);

  $effect(() => untrack(() => {
    let n = 0;
    const charger = () => {
      const m = ++n;
      void api.accueil
        .lire()
        .then(({ widgets }) => m === n && (widget = widgets.find((w) => w.id === id) ?? null))
        .catch(() => {});
    };
    charger();
    return api.accueil.surChange(charger);
  }));

  const shown = $derived(widget && !("erreur" in widget) ? widget : null);
  const preview = $derived(
    shown
      ? previewData({ choisie: executions.choisie, detail: executions.detail, liste: executions.liste, widget: shown })
      : null,
  );
  const taille = $derived(shown ? freeUnits(shown.placement) : { l: 1, h: 1 });
  const width = $derived(Math.min(480, taille.l * COLUMN_PX + (taille.l - 1) * GAP_PX));
  const hauteur = $derived(Math.min(360, taille.h * ROW_PX + (taille.h - 1) * GAP_PX));
</script>

<div class="apercu" data-testid="apercu-widget">
  {#if !shown || !preview}
    <p class="doux">{widget && "erreur" in widget ? `Widget illisible : ${widget.erreur}` : "Chargement…"}</p>
  {:else}
    <div class="cadre" style:width="{width}px" style:height="{hauteur}px">
      <CadreWidget
        widget={shown}
        donnees={preview.donnees}
        {taille}
        etat={{ statut: shown.etat.statut, derniereMaj: shown.etat.derniereMaj }}
      />
    </div>
    {#if preview.mention}<p class="doux mention" data-testid="apercu-mention">Aperçu : données non gardées dans cette exécution</p>{/if}
  {/if}
</div>

<style>
  .apercu { position: absolute; left: 12px; bottom: 12px; z-index: 4; display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 10px; border: 1px solid var(--bord); background: var(--fond-barre); box-shadow: var(--ombre-modale); max-width: calc(100% - 24px); }
  .cadre { display: flex; max-width: 100%; border-radius: 6px; overflow: hidden; }
  .doux { margin: 0; font-size: 11px; color: var(--texte-doux); }
  .mention { max-width: 260px; }
</style>
