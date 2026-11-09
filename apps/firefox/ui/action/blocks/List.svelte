<script lang="ts">
  import PageLink from "../PageLink.svelte";
  import { andOthers, sections, type Collection, type PageContext, type LienPage as Lien } from "../types";

  type Element = { titre: string; sousTitre: string | null; lien: Lien | null };
  let { p, ctx }: { p: Collection<Element>; ctx: PageContext } = $props();
</script>

<div data-testid="bloc-liste">
  {#each sections(p) as s, i (i)}
    {#if s.valeur !== null}<h3 class="pa-section">{s.valeur}</h3>{/if}
    <ul class="pa-liste">
      {#each s.elements as e, j (j)}
        <li>
          {#if e.lien}<PageLink lien={e.lien} {ctx} />{:else}<span class="pa-texte">{e.titre}</span>{/if}
          {#if e.sousTitre}<span class="sous-titre">{e.sousTitre}</span>{/if}
        </li>
      {/each}
    </ul>
  {/each}
  {#if p.autres > 0}<p class="pa-autres">{andOthers(p.autres)}</p>{/if}
</div>
