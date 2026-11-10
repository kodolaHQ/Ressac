<script lang="ts">
  import PageLink from "../PageLink.svelte";
  import type { PageContext, LinkRef as Link } from "../types";

  let { p, ctx }: { p: { link: Link }; ctx: PageContext } = $props();
</script>

<div data-testid="bloc-lien"><PageLink link={p.link} {ctx} /></div>
