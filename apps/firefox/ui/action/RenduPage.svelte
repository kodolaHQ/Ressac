<script lang="ts">
  import type { RenderedBlock, RenderedPage } from "@webaios/noyau";
  import { NO_RESULT, FALLBACK_MENTION } from "../../shared/actions";
  import ComponentFrame from "../ActionComponentFrame.svelte";
  import Cartes from "./blocs/Cartes.svelte";
  import Champs from "./blocs/Champs.svelte";
  import Figure from "./blocs/Chiffre.svelte";
  import Figures from "./blocs/Chiffres.svelte";
  import Columns from "./blocs/Colonnes.svelte";
  import Boxed from "./blocs/Encadre.svelte";
  import BlockError from "./blocs/ErreurBloc.svelte";
  import Etiquettes from "./blocs/Etiquettes.svelte";
  import Group from "./blocs/Groupe.svelte";
  import Lien from "./blocs/Lien.svelte";
  import List from "./blocs/Liste.svelte";
  import Paragraph from "./blocs/Paragraphe.svelte";
  import Tableau from "./blocs/Tableau.svelte";
  import Titre from "./blocs/Titre.svelte";
  import "./page.css";
  import type { PageContext } from "./types";

  /**
   * A rendered page (resolved by the kernel: references computed, links and images checked). Everything shows as text,
   * never as HTML. `composants` false (preview): the agent's components are not loaded, a neutral frame replaces them.
   */
  let { page, action, execution, composants: components = true }: { page: RenderedPage; action: string; execution: string; composants?: boolean } = $props();
  const ctx: PageContext = $derived({ action, execution });

  // A block's props are typed by each component (shapes fixed by the kernel's pages/resoudre.ts).
  const p = (b: RenderedBlock) => ("props" in b ? b.props : {}) as never;
</script>

{#snippet list(blocs: RenderedBlock[] | undefined)}
  {#each blocs ?? [] as b, i (i)}
    {#if "message" in b}
      <BlockError message={b.message} />
    {:else if b.composant === "titre"}
      <Titre p={p(b)} />
    {:else if b.composant === "paragraphe"}
      <Paragraph p={p(b)} />
    {:else if b.composant === "encadre"}
      <Boxed p={p(b)} />
    {:else if b.composant === "chiffre"}
      <Figure p={p(b)} />
    {:else if b.composant === "chiffres"}
      <Figures p={p(b)} />
    {:else if b.composant === "liste"}
      <List p={p(b)} {ctx} />
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
      <Group p={p(b)}><div class="pa-blocs">{@render list(b.blocs)}</div></Group>
    {:else if b.composant === "colonnes"}
      <Columns>
        {#snippet gauche()}{@render list(b.gauche)}{/snippet}
        {#snippet droite()}{@render list(b.droite)}{/snippet}
      </Columns>
    {:else if components}
      <ComponentFrame nom={b.composant} props={b.props} />
    {:else}
      <div class="pa-composant-apercu" data-testid="bloc-{b.composant}">{b.composant}</div>
    {/if}
  {/each}
{/snippet}

<div class="page-action" data-testid="rendu-page">
  {#if page.secours}<p class="pa-mention" data-testid="mention-secours">{FALLBACK_MENTION}</p>{/if}
  {#if page.blocs.length === 0}<p class="pa-vide">{NO_RESULT}</p>{/if}
  <div class="pa-blocs">{@render list(page.blocs)}</div>
</div>
