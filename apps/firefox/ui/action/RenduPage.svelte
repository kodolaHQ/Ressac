<script lang="ts">
  import type { RenderedBlock, RenderedPage } from "@webaios/noyau";
  import { AUCUN_RESULTAT, MENTION_SECOURS } from "../../shared/actions";
  import CadreComposant from "../ActionComponentFrame.svelte";
  import Cartes from "./blocs/Cartes.svelte";
  import Champs from "./blocs/Champs.svelte";
  import Chiffre from "./blocs/Chiffre.svelte";
  import Chiffres from "./blocs/Chiffres.svelte";
  import Colonnes from "./blocs/Colonnes.svelte";
  import Encadre from "./blocs/Encadre.svelte";
  import ErreurBloc from "./blocs/ErreurBloc.svelte";
  import Etiquettes from "./blocs/Etiquettes.svelte";
  import Groupe from "./blocs/Groupe.svelte";
  import Lien from "./blocs/Lien.svelte";
  import Liste from "./blocs/Liste.svelte";
  import Paragraphe from "./blocs/Paragraphe.svelte";
  import Tableau from "./blocs/Tableau.svelte";
  import Titre from "./blocs/Titre.svelte";
  import "./page.css";
  import type { ContextePage } from "./types";

  /**
   * A rendered page (resolved by the kernel: references computed, links and images checked). Everything shows as text,
   * never as HTML. `composants` false (preview): the agent's components are not loaded, a neutral frame replaces them.
   */
  let { page, action, execution, composants = true }: { page: RenderedPage; action: string; execution: string; composants?: boolean } = $props();
  const ctx: ContextePage = $derived({ action, execution });

  // A block's props are typed by each component (shapes fixed by the kernel's pages/resoudre.ts).
  const p = (b: RenderedBlock) => ("props" in b ? b.props : {}) as never;
</script>

{#snippet liste(blocs: RenderedBlock[] | undefined)}
  {#each blocs ?? [] as b, i (i)}
    {#if "message" in b}
      <ErreurBloc message={b.message} />
    {:else if b.composant === "titre"}
      <Titre p={p(b)} />
    {:else if b.composant === "paragraphe"}
      <Paragraphe p={p(b)} />
    {:else if b.composant === "encadre"}
      <Encadre p={p(b)} />
    {:else if b.composant === "chiffre"}
      <Chiffre p={p(b)} />
    {:else if b.composant === "chiffres"}
      <Chiffres p={p(b)} />
    {:else if b.composant === "liste"}
      <Liste p={p(b)} {ctx} />
    {:else if b.composant === "cartes"}
      <Cartes p={p(b)} {ctx} />
    {:else if b.composant === "tableau"}
      <Tableau p={p(b)} {ctx} />
    {:else if b.composant === "champs"}
      <Champs p={p(b)} />
    {:else if b.composant === "etiquettes"}
      <Etiquettes p={p(b)} />
    {:else if b.composant === "lien"}
      <Lien p={p(b)} {ctx} />
    {:else if b.composant === "groupe"}
      <Groupe p={p(b)}><div class="pa-blocs">{@render liste(b.blocs)}</div></Groupe>
    {:else if b.composant === "colonnes"}
      <Colonnes>
        {#snippet gauche()}{@render liste(b.gauche)}{/snippet}
        {#snippet droite()}{@render liste(b.droite)}{/snippet}
      </Colonnes>
    {:else if composants}
      <CadreComposant nom={b.composant} props={b.props} />
    {:else}
      <div class="pa-composant-apercu" data-testid="bloc-{b.composant}">{b.composant}</div>
    {/if}
  {/each}
{/snippet}

<div class="page-action" data-testid="rendu-page">
  {#if page.secours}<p class="pa-mention" data-testid="mention-secours">{MENTION_SECOURS}</p>{/if}
  {#if page.blocs.length === 0}<p class="pa-vide">{AUCUN_RESULTAT}</p>{/if}
  <div class="pa-blocs">{@render liste(page.blocs)}</div>
</div>
