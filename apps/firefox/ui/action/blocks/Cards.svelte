<script lang="ts">
  import ImageRef from "../../ActionImage.svelte";
  import PageLink from "../PageLink.svelte";
  import { andOthers, sections, type Collection, type PageContext, type ImageRef as Image, type LinkRef as Link } from "../types";

  type Card = { title: string; subtitle: string | null; image: Image; value: string | null; tags: string[]; link: Link | null };
  let { p, ctx }: { p: Collection<Card>; ctx: PageContext } = $props();
</script>

<div data-testid="bloc-cartes">
  {#each sections(p) as s, i (i)}
    {#if s.value !== null}<h3 class="pa-section">{s.value}</h3>{/if}
    <div class="pa-cartes">
      {#each s.items as c, j (j)}
        <article class="pa-carte">
          {#if c.image}<ImageRef image={c.image} {ctx} />{/if}
          <div class="corps">
            <span class="titre">{#if c.link}<PageLink link={c.link} {ctx} />{:else}{c.title}{/if}</span>
            {#if c.subtitle}<span class="sous-titre">{c.subtitle}</span>{/if}
            {#if c.value}<span class="valeur">{c.value}</span>{/if}
            {#if c.tags.length}
              <div class="pa-etiquettes">{#each c.tags as t, k (k)}<span class="pa-etiquette">{t}</span>{/each}</div>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/each}
  {#if p.others > 0}<p class="pa-autres">{andOthers(p.others)}</p>{/if}
</div>
