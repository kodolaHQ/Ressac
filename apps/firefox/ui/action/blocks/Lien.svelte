<script lang="ts">
  import PageLink from "../LienPage.svelte";
  import type { PageContext, LienPage as Lien } from "../types";

  let { p, ctx }: { p: { lien: Lien }; ctx: PageContext } = $props();
</script>

<div data-testid="bloc-lien"><PageLink lien={p.lien} {ctx} /></div>
