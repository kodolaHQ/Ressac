<script lang="ts">
  import LienPage from "../LienPage.svelte";
  import type { PageContext, LienPage as Lien } from "../types";

  let { p, ctx }: { p: { lien: Lien }; ctx: PageContext } = $props();
</script>

<div data-testid="bloc-lien"><LienPage lien={p.lien} {ctx} /></div>
