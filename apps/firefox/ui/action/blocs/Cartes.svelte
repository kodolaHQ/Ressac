<script lang="ts">
  import ImagePage from "../ImagePage.svelte";
  import LienPage from "../LienPage.svelte";
  import { etAutres, sections, type Collection, type ContextePage, type ImagePage as Image, type LienPage as Lien } from "../types";

  type Carte = { titre: string; sousTitre: string | null; image: Image; valeur: string | null; etiquettes: string[]; lien: Lien | null };
  let { p, ctx }: { p: Collection<Carte>; ctx: ContextePage } = $props();
</script>

<div data-testid="bloc-cartes">
  {#each sections(p) as s, i (i)}
    {#if s.valeur !== null}<h3 class="pa-section">{s.valeur}</h3>{/if}
    <div class="pa-cartes">
      {#each s.elements as c, j (j)}
        <article class="pa-carte">
          {#if c.image}<ImagePage image={c.image} {ctx} />{/if}
          <div class="corps">
            <span class="titre">{#if c.lien}<LienPage lien={c.lien} {ctx} />{:else}{c.titre}{/if}</span>
            {#if c.sousTitre}<span class="sous-titre">{c.sousTitre}</span>{/if}
            {#if c.valeur}<span class="valeur">{c.valeur}</span>{/if}
            {#if c.etiquettes.length}
              <div class="pa-etiquettes">{#each c.etiquettes as t, k (k)}<span class="pa-etiquette">{t}</span>{/each}</div>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/each}
  {#if p.autres > 0}<p class="pa-autres">{etAutres(p.autres)}</p>{/if}
</div>
