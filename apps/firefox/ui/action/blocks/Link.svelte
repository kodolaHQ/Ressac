<script lang="ts">
  import PageLink from "../PageLink.svelte";
  import type { PageContext, LinkRef as Lien } from "../types";

  let { p, ctx }: { p: { link: Lien }; ctx: PageContext } = $props();
</script>

<div data-testid="bloc-lien"><PageLink link={p.link} {ctx} /></div>
