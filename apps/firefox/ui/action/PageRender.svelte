<script lang="ts">
  import type { RenderedBlock, RenderedPage } from "@webaios/kernel";
  import { NO_RESULT, FALLBACK_MENTION } from "../../shared/actions";
  import ComponentFrame from "../ActionComponentFrame.svelte";
  import Cards from "./blocks/Cards.svelte";
  import Fields from "./blocks/Fields.svelte";
  import Figure from "./blocks/Figure.svelte";
  import Figures from "./blocks/Figures.svelte";
  import Columns from "./blocks/Columns.svelte";
  import Boxed from "./blocks/Callout.svelte";
  import BlockError from "./blocks/BlockError.svelte";
  import Labels from "./blocks/Labels.svelte";
  import Group from "./blocks/Group.svelte";
  import Link from "./blocks/Link.svelte";
  import List from "./blocks/List.svelte";
  import Paragraph from "./blocks/Paragraph.svelte";
  import Table from "./blocks/Table.svelte";
  import Title from "./blocks/Title.svelte";
  import "./page.css";
  import type { PageContext } from "./types";

  /**
   * A rendered page (resolved by the kernel: references computed, links and images checked). Everything shows as text,
   * never as HTML. `composants` false (preview): the agent's components are not loaded, a neutral frame replaces them.
   */
  let { page, action, run, components: components = true }: { page: RenderedPage; action: string; run: string; components?: boolean } = $props();
  const ctx: PageContext = $derived({ action, run });

  // A block's props are typed by each component (shapes fixed by the kernel's pages/resolve.ts).
  const p = (b: RenderedBlock) => ("props" in b ? b.props : {}) as never;
</script>

{#snippet list(blocks: RenderedBlock[] | undefined)}
  {#each blocks ?? [] as b, i (i)}
    {#if "message" in b}
      <BlockError message={b.message} />
    {:else if b.component === "title"}
      <Title p={p(b)} />
    {:else if b.component === "paragraph"}
      <Paragraph p={p(b)} />
    {:else if b.component === "callout"}
      <Boxed p={p(b)} />
    {:else if b.component === "figure"}
      <Figure p={p(b)} />
    {:else if b.component === "figures"}
      <Figures p={p(b)} />
    {:else if b.component === "list"}
      <List p={p(b)} {ctx} />
    {:else if b.component === "cards"}
      <Cards p={p(b)} {ctx} />
    {:else if b.component === "table"}
      <Table p={p(b)} {ctx} />
    {:else if b.component === "fields"}
      <Fields p={p(b)} />
    {:else if b.component === "tags"}
      <Labels p={p(b)} />
    {:else if b.component === "link"}
      <Link p={p(b)} {ctx} />
    {:else if b.component === "group"}
      <Group p={p(b)}><div class="pa-blocks">{@render list(b.blocks)}</div></Group>
    {:else if b.component === "columns"}
      <Columns>
        {#snippet left()}{@render list(b.left)}{/snippet}
        {#snippet right()}{@render list(b.right)}{/snippet}
      </Columns>
    {:else if components}
      <ComponentFrame name={b.component} props={b.props} />
    {:else}
      <div class="pa-component-preview" data-testid="block-{b.component}">{b.component}</div>
    {/if}
  {/each}
{/snippet}

<div class="page-action" data-testid="page-render">
  {#if page.fallback}<p class="pa-mention" data-testid="fallback-mention">{FALLBACK_MENTION}</p>{/if}
  {#if page.blocks.length === 0}<p class="pa-empty">{NO_RESULT}</p>{/if}
  <div class="pa-blocks">{@render list(page.blocks)}</div>
</div>
