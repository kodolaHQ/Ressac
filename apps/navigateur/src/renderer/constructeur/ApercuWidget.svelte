<script lang="ts">
  import { untrack } from "svelte";
  import type { WidgetAffiche } from "../../commun/api";
  import CadreWidget from "../composants/CadreWidget.svelte";
  import { api } from "../etat.svelte";
  import { ECART_PX, RANGEE_PX } from "../grille";
  import { donneesApercu } from "./apercu";
  import type { Executions } from "./executions.svelte";

  /**
   * L'aperçu flottant du widget, tel qu'il apparaît sur l'accueil (même cadre isolé), avec les données de l'exécution
   * choisie.
   */
  let { id, executions }: { id: string; executions: Executions } = $props();

  /** Largeur d'une colonne de l'accueil à sa largeur maximale (1200 px, 12 colonnes). */
  const COLONNE_PX = 89;
  let widget = $state.raw<WidgetAffiche | null>(null);

  $effect(() => untrack(() => {
    let n = 0;
    const charger = () => {
      const m = ++n;
      void api.accueil
        .lire()
        .then((ws) => m === n && (widget = ws.find((w) => w.id === id) ?? null))
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
  const largeur = $derived(affiche ? Math.min(480, affiche.placement.l * COLONNE_PX + (affiche.placement.l - 1) * ECART_PX) : 0);
  const hauteur = $derived(affiche ? Math.min(360, affiche.placement.h * RANGEE_PX + (affiche.placement.h - 1) * ECART_PX) : 0);
</script>

<div class="apercu" data-testid="apercu-widget">
  {#if !affiche || !apercu}
    <p class="doux">{widget && "erreur" in widget ? `Widget illisible : ${widget.erreur}` : "Chargement…"}</p>
  {:else}
    <div class="cadre" style:width="{largeur}px" style:height="{hauteur}px">
      <CadreWidget
        widget={affiche}
        donnees={apercu.donnees}
        taille={{ l: affiche.placement.l, h: affiche.placement.h }}
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
