<script lang="ts">
  import ActionImage from "../../ActionImage.svelte";
  import PageLink from "../PageLink.svelte";
  import type { PageContext, ImageRef as Image, LinkRef as Link } from "../types";

  /** The featured item: a large photo card, or an answer box without a photo. */
  let { p, ctx }: { p: { label: string | null; title: string; subtitle: string | null; image: Image; value: string | null; text: string | null; link: Link | null }; ctx: PageContext } = $props();
</script>

<article class="pa-highlight" class:with-photo={!!p.image} data-testid="block-highlight">
  {#if p.image}<div class="pa-photo"><ActionImage image={p.image} {ctx} /></div>{/if}
  <div class="body">
    {#if p.label}<span class="label">{p.label}</span>{/if}
    <span class="title">{#if p.link}<PageLink link={p.link} {ctx} />{:else}{p.title}{/if}</span>
    {#if p.value}<span class="value">{p.value}</span>{/if}
    {#if p.subtitle}<span class="subtitle">{p.subtitle}</span>{/if}
    {#if p.text}<p>{p.text}</p>{/if}
  </div>
</article>
