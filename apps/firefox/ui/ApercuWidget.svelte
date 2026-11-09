<script lang="ts">
  import { untrack } from "svelte";
  import type { WidgetAffiche } from "../shared/api";
  import { api } from "../ui/etat.svelte";
  import { ECART_PX, RANGEE_PX } from "../ui/grille";
  import { donneesApercu } from "../ui/constructeur/apercu";
  import type { Executions } from "../ui/constructeur/executions.svelte";
  import CadreWidget from "./CadreWidget.svelte";
  import { unitesLibres } from "./grille-libre";

  /**
   * The floating preview of the widget as the home page shows it (same isolated frame), with
   * the chosen run's data. The Firefox home places widgets freely: its placement is turned back into grid units.
   */
  let { id, executions }: { id: string; executions: Executions } = $props();

  /** Width of a home column at its maximum width (1200 px, 12 columns). */
  const COLONNE_PX = 89;
  let widget = $state.raw<WidgetAffiche | null>(null);

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

  const affiche = $derived(widget && !("erreur" in widget) ? widget : null);
  const apercu = $derived(
    affiche
      ? donneesApercu({ choisie: executions.choisie, detail: executions.detail, liste: executions.liste, widget: affiche })
      : null,
  );
  const taille = $derived(affiche ? unitesLibres(affiche.placement) : { l: 1, h: 1 });
  const largeur = $derived(Math.min(480, taille.l * COLONNE_PX + (taille.l - 1) * ECART_PX));
  const hauteur = $derived(Math.min(360, taille.h * RANGEE_PX + (taille.h - 1) * ECART_PX));
</script>

<div class="apercu" data-testid="apercu-widget">
  {#if !affiche || !apercu}
    <p class="doux">{widget && "erreur" in widget ? `Widget illisible : ${widget.erreur}` : "Chargement…"}</p>
  {:else}
    <div class="cadre" style:width="{largeur}px" style:height="{hauteur}px">
      <CadreWidget
        widget={affiche}
        donnees={apercu.donnees}
        {taille}
        etat={{ statut: affiche.etat.statut, derniereMaj: affiche.etat.derniereMaj }}
      />
    </div>
    {#if apercu.mention}<p class="doux mention" data-testid="apercu-mention">Aperçu : données non gardées dans cette exécution</p>{/if}
  {/if}
</div>

<style>
  .apercu { position: absolute; left: 12px; bottom: 12px; z-index: 4; display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 10px; border: 1px solid var(--bord); background: var(--fond-barre); box-shadow: var(--ombre-modale); max-width: calc(100% - 24px); }
  .cadre { display: flex; max-width: 100%; border-radius: 6px; overflow: hidden; }
  .doux { margin: 0; font-size: 11px; color: var(--texte-doux); }
  .mention { max-width: 260px; }
</style>
