<script lang="ts">
  import ImageRef from "../../ActionImage.svelte";
  import PageLink from "../PageLink.svelte";
  import { andOthers, sections, type Collection, type PageContext, type ImageRef as Image, type LinkRef as Link } from "../types";

  type Card = { title: string; subtitle: string | null; image: Image; value: string | null; tags: string[]; warnings: string[]; link: Link | null };
  let { p, ctx }: { p: Collection<Card>; ctx: PageContext } = $props();
</script>

<div data-testid="block-cards">
  {#each sections(p) as s, i (i)}
    {#if s.value !== null}<h3 class="pa-section">{s.value}</h3>{/if}
    <div class="pa-cards">
      {#each s.items as c, j (j)}
        <article class="pa-card">
          <!-- The price sits on the photo when there is one. -->
          {#if c.image}<div class="pa-photo"><ImageRef image={c.image} {ctx} />{#if c.value}<span class="value">{c.value}</span>{/if}</div>{/if}
          <div class="body">
            <span class="title">{#if c.link}<PageLink link={c.link} {ctx} />{:else}{c.title}{/if}</span>
            {#if c.subtitle}<span class="subtitle">{c.subtitle}</span>{/if}
            {#if c.value && !c.image}<span class="value">{c.value}</span>{/if}
            {#if c.tags.length || c.warnings.length}
              <div class="pa-tags">
                {#each c.warnings as t, k (k)}<span class="pa-tag pa-warning">{t}</span>{/each}
                {#each c.tags as t, k (k)}<span class="pa-tag">{t}</span>{/each}
              </div>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/each}
  {#if p.others > 0}<p class="pa-others">{andOthers(p.others)}</p>{/if}
</div>
