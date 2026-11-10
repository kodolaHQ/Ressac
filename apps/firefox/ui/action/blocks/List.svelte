<script lang="ts">
  import PageLink from "../PageLink.svelte";
  import { andOthers, sections, type Collection, type PageContext, type LinkRef as Link } from "../types";

  type Element = { title: string; subtitle: string | null; link: Link | null };
  let { p, ctx }: { p: Collection<Element>; ctx: PageContext } = $props();
</script>

<div data-testid="block-list">
  {#each sections(p) as s, i (i)}
    {#if s.value !== null}<h3 class="pa-section">{s.value}</h3>{/if}
    <ul class="pa-list">
      {#each s.items as e, j (j)}
        <li>
          {#if e.link}<PageLink link={e.link} {ctx} />{:else}<span class="pa-text">{e.title}</span>{/if}
          {#if e.subtitle}<span class="subtitle">{e.subtitle}</span>{/if}
        </li>
      {/each}
    </ul>
  {/each}
  {#if p.others > 0}<p class="pa-others">{andOthers(p.others)}</p>{/if}
</div>
